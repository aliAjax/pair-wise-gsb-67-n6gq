import type {
  AcceptanceDefect, Certificate, EquipmentNode, FieldChange, OutboxRecord, PartyReply, SyncConflict
} from '../types/domain'
import { seedDefects, seedEquipment, seedPlant } from '../data/seed'

/**
 * 回传同步引擎（纯函数，不依赖 Pinia / 浏览器）。
 *
 * 合并规则（对应验收回传要求）：
 * - 同一字段：按“最后确认时间”取胜（confirmedAt 晚者覆盖）。
 * - 不同字段：分别保留，互不影响。
 * - 记录所依据的版本已被其他班组推进时，重叠字段进入冲突区，等待人工处理；
 *   非重叠字段在回传时即自动并入。
 * - 设备证书已失效、或记录基线版本早于已签署锁定版本时，直接进入冲突区，不并入。
 */

const TERMINAL_DEFECT_STATUS = ['已关闭', '带条件通过']

export const ITEM_FIELDS = ['status', 'measured', 'evidence', 'condition'] as const
export const CERT_FIELDS = ['name', 'issuer', 'expiresAt', 'verified'] as const
const DECISION_FIELDS = ['status', 'decisionNote', 'owner'] as const

export interface FieldMeta { version: number; confirmedAt: string; crew: string }
export interface EntityLock { version: number; plantVersion: number; signedAt: string }

export interface ServerState {
  equipment: EquipmentNode[]
  defects: AcceptanceDefect[]
  plantVersion: number
  signedAt: string | null
  /** 实体签署锁：key 形如 item:IT-I1 / cert:C-I1 / defect:AD-xx，记录签署时锁定的版本 */
  entityLocks: Record<string, EntityLock>
  /** 字段级元数据：实体 key -> 字段 -> 最后改动版本/确认时间/班组 */
  fieldMeta: Record<string, Record<string, FieldMeta>>
  scenario: string | null
}

export interface MergeContext {
  server: ServerState
  commissioningDate: string
  now: string
}

export interface MergeResult {
  record: OutboxRecord
  server: ServerState
  equipmentTouched: string[]
  defectsTouched: string[]
}

export const itemKey = (id: string) => `item:${id}`
export const certKey = (id: string) => `cert:${id}`
export const defectKey = (id: string) => `defect:${id}`

export function findItem(server: ServerState, equipmentId: string, itemId?: string) {
  const node = server.equipment.find((value) => value.id === equipmentId)
  return { node, item: node?.items.find((value) => value.id === itemId) }
}

export function findCert(server: ServerState, equipmentId: string, certificateId?: string) {
  const node = server.equipment.find((value) => value.id === equipmentId)
  return { node, certificate: node?.certificates.find((value) => value.id === certificateId) }
}

function metaOf(server: ServerState, key: string, field: string): FieldMeta | undefined {
  return server.fieldMeta[key]?.[field]
}

function stampMeta(server: ServerState, key: string, field: string, version: number, change: FieldChange, crew: string) {
  server.fieldMeta[key] ??= {}
  server.fieldMeta[key][field] = { version, confirmedAt: change.confirmedAt, crew }
}

function cloneRecord(record: OutboxRecord, patch: Partial<OutboxRecord>): OutboxRecord {
  return { ...structuredClone(record), ...patch, attempts: record.attempts + 1 }
}

function failRecord(record: OutboxRecord, message: string): OutboxRecord {
  return cloneRecord(record, { status: '失败', error: message, conflict: undefined })
}

function conflictRecord(record: OutboxRecord, conflict: SyncConflict, error?: string): OutboxRecord {
  return cloneRecord(record, { status: '冲突', conflict, error })
}

function mergedRecord(record: OutboxRecord, now: string): OutboxRecord {
  return cloneRecord(record, { status: '已回传', conflict: undefined, error: undefined, mergedAt: now })
}

function expiredCertificates(server: ServerState, equipmentId: string, commissioningDate: string): Certificate[] {
  const node = server.equipment.find((value) => value.id === equipmentId)
  return (node?.certificates ?? []).filter((cert) => cert.expiresAt < commissioningDate)
}

function equipmentBrief(server: ServerState, equipmentId: string) {
  const node = server.equipment.find((value) => value.id === equipmentId)
  return { equipmentId, equipmentName: node?.name ?? equipmentId, equipmentCode: node?.code ?? '' }
}

/**
 * 执行单条待回传记录的合并。返回新记录状态与合并后的服务端副本；
 * 任何分支都不修改入参。
 */
export function mergeRecord(input: OutboxRecord, ctx: MergeContext): MergeResult {
  const server = structuredClone(ctx.server)
  const equipmentTouched: string[] = []
  const defectsTouched: string[] = []
  const touchEquipment = (id: string) => { if (!equipmentTouched.includes(id)) equipmentTouched.push(id) }
  const touchDefect = (id: string) => { if (!defectsTouched.includes(id)) defectsTouched.push(id) }

  const fail = (message: string): MergeResult => ({ record: failRecord(input, message), server: ctx.server, equipmentTouched, defectsTouched })

  if (input.kind === '处理说明' || input.kind === '联合复验' || input.kind === '验收决定') {
    const defect = server.defects.find((value) => value.id === input.defectId)
    if (!defect) return fail(`缺陷${input.defectId}在服务端不存在，无法回传`)
    const dKey = defectKey(defect.id)
    touchDefect(defect.id)
    touchEquipment(input.equipmentId)

    // 阻断一：签署版本不匹配（基线版本早于签署锁定版本）
    const lock = server.entityLocks[dKey]
    if (lock && input.baseVersion < lock.version) {
      return { record: conflictRecord(input, {
        type: '签署版本不匹配', ...equipmentBrief(server, input.equipmentId),
        targetRef: defect.id, targetLabel: `缺陷「${defect.title}」`,
        fields: [], certificates: [], baseVersion: input.baseVersion, serverVersion: defect.version, signedVersion: lock.version,
        message: `该缺陷已随签署包 V${lock.plantVersion} 锁定（V${lock.version}），本记录依据 V${input.baseVersion} 编制，需以签署版本重定基线后重试。`
      }), server: ctx.server, equipmentTouched, defectsTouched }
    }

    // 阻断二：证书失效
    const expired = expiredCertificates(server, input.equipmentId, ctx.commissioningDate)
    if (expired.length) {
      return { record: conflictRecord(input, certConflict(input, server, expired)), server: ctx.server, equipmentTouched, defectsTouched }
    }

    if (input.kind === '处理说明') {
      const statusMeta = metaOf(server, dKey, 'status')
      const otherClosed = statusMeta && statusMeta.version > input.baseVersion && statusMeta.crew !== input.crew
        && TERMINAL_DEFECT_STATUS.includes(String(defect.status))
      if (otherClosed) {
        return { record: conflictRecord(input, {
          type: '被其他班组改过', ...equipmentBrief(server, input.equipmentId),
          targetRef: defect.id, targetLabel: `缺陷「${defect.title}」处理说明`,
          fields: ['status'], certificates: [], baseVersion: input.baseVersion, serverVersion: defect.version,
          localValue: input.reply?.party, serverValue: defect.status,
          remoteCrew: statusMeta!.crew, remoteConfirmedAt: statusMeta!.confirmedAt,
          message: `其他班组（${statusMeta!.crew}）已于 ${formatTime(statusMeta!.confirmedAt)} 将缺陷关闭为「${defect.status}」，处理说明不能再并入，请人工确认。`
        }), server: ctx.server, equipmentTouched, defectsTouched }
      }
      if (input.reply && !replyExists(defect, input.reply)) defect.replies.unshift(input.reply)
      if (!TERMINAL_DEFECT_STATUS.includes(defect.status)) defect.status = '待联合复验'
      defect.version += 1
      return { record: mergedRecord(input, ctx.now), server, equipmentTouched, defectsTouched }
    }

    if (input.kind === '联合复验') {
      const statusMeta = metaOf(server, dKey, 'status')
      const otherMoved = statusMeta && statusMeta.version > input.baseVersion && statusMeta.crew !== input.crew
      if (otherMoved && String(defect.status) !== (input.retest?.passed ? '已关闭' : '整改中')) {
        return { record: conflictRecord(input, {
          type: '被其他班组改过', ...equipmentBrief(server, input.equipmentId),
          targetRef: defect.id, targetLabel: `缺陷「${defect.title}」第${input.retest?.round}轮复验`,
          fields: ['status'], certificates: [], baseVersion: input.baseVersion, serverVersion: defect.version,
          localValue: input.retest?.passed ? '已关闭' : '整改中', serverValue: defect.status,
          remoteCrew: statusMeta!.crew, remoteConfirmedAt: statusMeta!.confirmedAt,
          message: `其他班组（${statusMeta!.crew}）已于 ${formatTime(statusMeta!.confirmedAt)} 将缺陷状态改为「${defect.status}」，复验结论存在冲突。`
        }), server: ctx.server, equipmentTouched, defectsTouched }
      }
      if (input.retest && !defect.retests.some((value) => value.round === input.retest!.round && value.testedAt === input.retest!.testedAt)) {
        defect.retests.unshift(input.retest)
      }
      defect.status = input.retest?.passed ? '已关闭' : '整改中'
      defect.version += 1
      stampMeta(server, dKey, 'status', defect.version, { value: defect.status, confirmedAt: input.retest?.testedAt ?? ctx.now }, input.crew)
      return { record: mergedRecord(input, ctx.now), server, equipmentTouched, defectsTouched }
    }

    // 验收决定：字段级合并
    return mergeFields(input, ctx, server, dKey, defect, DECISION_FIELDS, `缺陷「${defect.title}」验收决定`,
      equipmentTouched, defectsTouched)
  }

  if (input.kind === '证书更新') {
    const { node, certificate } = findCert(server, input.equipmentId, input.certificateId)
    if (!node || !certificate) return fail(`证书在服务端不存在（设备${input.equipmentId}），无法回传`)
    const cKey = certKey(certificate.id)
    touchEquipment(node.id)
    const lock = server.entityLocks[cKey]
    if (lock && input.baseVersion < lock.version) {
      return { record: conflictRecord(input, {
        type: '签署版本不匹配', ...equipmentBrief(server, node.id),
        targetRef: certificate.id, targetLabel: `证书「${certificate.name}」`,
        fields: [], certificates: [{ id: certificate.id, name: certificate.name, expiresAt: certificate.expiresAt, verified: certificate.verified }],
        baseVersion: input.baseVersion, serverVersion: certificate.version, signedVersion: lock.version,
        message: `证书已随签署包 V${lock.plantVersion} 锁定（V${lock.version}），本更新依据 V${input.baseVersion}，需重定基线。`
      }), server: ctx.server, equipmentTouched, defectsTouched }
    }
    return mergeFields(input, ctx, server, cKey, certificate, CERT_FIELDS, `证书「${certificate.name}」`,
      equipmentTouched, defectsTouched)
  }

  // 验收项更新
  const { node, item } = findItem(server, input.equipmentId, input.itemId)
  if (!node || !item) return fail(`验收项在服务端不存在（设备${input.equipmentId}/${input.itemId}），无法回传`)
  const iKey = itemKey(item.id)
  touchEquipment(node.id)

  const lock = server.entityLocks[iKey]
  if (lock && input.baseVersion < lock.version) {
    return { record: conflictRecord(input, {
      type: '签署版本不匹配', ...equipmentBrief(server, node.id),
      targetRef: item.id, targetLabel: `验收项 ${item.id}「${item.standard}」`,
      fields: [], certificates: [], baseVersion: input.baseVersion, serverVersion: item.version, signedVersion: lock.version,
      message: `验收项已随签署包 V${lock.plantVersion} 锁定（V${lock.version}），本记录依据 V${input.baseVersion} 录入，需以签署版本重定基线后重试。`
    }), server: ctx.server, equipmentTouched, defectsTouched }
  }

  const expired = expiredCertificates(server, node.id, ctx.commissioningDate)
  if (expired.length) {
    return { record: conflictRecord(input, certConflict(input, server, expired)), server: ctx.server, equipmentTouched, defectsTouched }
  }

  return mergeFields(input, ctx, server, iKey, item, ITEM_FIELDS, `验收项 ${item.id}「${item.standard}」`,
    equipmentTouched, defectsTouched)
}

function certConflict(input: OutboxRecord, server: ServerState, expired: Certificate[]): SyncConflict {
  const labels = expired.map((cert) => `${cert.name}（有效期至${cert.expiresAt}）`).join('、')
  const targetLabel = input.kind === '验收项更新'
    ? `验收项 ${input.itemId}`
    : input.kind === '证书更新'
      ? `证书「${expired[0]?.name ?? input.certificateId}」`
      : `缺陷 ${input.defectId}`
  return {
    type: '证书失效', ...equipmentBrief(server, input.equipmentId),
    targetRef: input.itemId ?? input.certificateId ?? input.defectId ?? input.equipmentId,
    targetLabel,
    fields: [], certificates: expired.map((cert) => ({ id: cert.id, name: cert.name, expiresAt: cert.expiresAt, verified: cert.verified })),
    baseVersion: input.baseVersion, serverVersion: 0,
    message: `设备证书已在并网日期前失效：${labels}。续期并通过核验后重试回传。`
  }
}

/**
 * 字段级合并：服务端版本未推进则整体并入；否则重叠字段（被其他班组改过）挂起进冲突区，
 * 非重叠字段立即并入。
 */
function mergeFields(
  input: OutboxRecord, ctx: MergeContext, server: ServerState, entityKey: string, entity: { version: number },
  knownFields: readonly string[], targetLabel: string, equipmentTouched: string[], defectsTouched: string[]
): MergeResult {
  const changedFields = Object.keys(input.changes).filter((field) => knownFields.includes(field))
  const apply = (fields: string[]) => {
    entity.version += 1
    for (const field of fields) {
      const change = input.changes[field]
      ;(entity as Record<string, unknown>)[field] = change.value
      stampMeta(server, entityKey, field, entity.version, change, input.crew)
    }
  }

  if (entity.version === input.baseVersion) {
    apply(changedFields)
    return { record: mergedRecord(input, ctx.now), server, equipmentTouched, defectsTouched }
  }

  const overlap = changedFields.filter((field) => {
    const meta = metaOf(server, entityKey, field)
    return meta && meta.version > input.baseVersion && meta.crew !== input.crew
      && String(meta.confirmedAt) !== String(input.changes[field].confirmedAt)
  })
  const disjoint = changedFields.filter((field) => !overlap.includes(field))
  if (disjoint.length) apply(disjoint)

  if (!overlap.length) {
    return { record: mergedRecord(input, ctx.now), server, equipmentTouched, defectsTouched }
  }

  const first = overlap[0]
  const remoteMetas = overlap.map((field) => ({ field, meta: metaOf(server, entityKey, field)! }))
  return {
    record: conflictRecord(input, {
      type: '被其他班组改过', ...equipmentBrief(server, input.equipmentId),
      targetRef: entityKey.split(':')[1], targetLabel,
      fields: overlap, certificates: [], baseVersion: input.baseVersion, serverVersion: entity.version,
      localValue: formatValue(input.changes[first].value), serverValue: formatValue((entity as Record<string, unknown>)[first]),
      remoteCrew: remoteMetas[0].meta.crew, remoteConfirmedAt: remoteMetas[0].meta.confirmedAt,
      message: `其他班组（${remoteMetas[0].meta.crew}）改过 ${overlap.join('、')} 等字段。同字段将按最后确认时间合并，不同字段已分别保留，请确认合并结果。`
    }),
    server, equipmentTouched, defectsTouched
  }
}

/** 冲突区“按最后确认时间合并”：对每个挂起字段比较时间戳后落盘。 */
export function resolveOverlapByTime(serverInput: ServerState, record: OutboxRecord, now: string): ServerState {
  const server = structuredClone(serverInput)
  const entity = locateEntity(server, record)
  if (!entity) return serverInput
  const key = record.kind === '验收项更新' ? itemKey(record.itemId!)
    : record.kind === '证书更新' ? certKey(record.certificateId!)
      : defectKey(record.defectId!)
  entity.version += 1
  for (const field of record.conflict?.fields ?? []) {
    const change = record.changes[field]
    const remote = metaOf(server, key, field)
    if (!remote || change.confirmedAt >= remote.confirmedAt) {
      ;(entity as Record<string, unknown>)[field] = change.value
      stampMeta(server, key, field, entity.version, change, record.crew)
    }
  }
  return server
}

export function locateEntity(server: ServerState, record: OutboxRecord): { key: string; version: number; [k: string]: unknown } | undefined {
  if (record.kind === '证书更新') return findCert(server, record.equipmentId, record.certificateId).certificate as any
  if (record.kind === '验收项更新') return findItem(server, record.equipmentId, record.itemId).item as any
  const defect = server.defects.find((value) => value.id === record.defectId)
  return defect ? Object.assign(defect, { key: defectKey(defect.id) }) as any : undefined
}

function replyExists(defect: AcceptanceDefect, reply: PartyReply) {
  return defect.replies.some((value) => value.party === reply.party && value.repliedAt === reply.repliedAt && value.content === reply.content)
}

function formatValue(value: unknown) {
  if (typeof value === 'boolean') return value ? '是' : '否'
  return value === null || value === undefined ? '' : String(value)
}

function formatTime(value: string) {
  return value.replace('T', ' ').slice(0, 16)
}

/** 依据本地数据建立全新的服务端快照（首次使用或重置后）。 */
export function createFreshServer(equipment: EquipmentNode[], defects: AcceptanceDefect[], plantVersion: number): ServerState {
  const server: ServerState = {
    equipment: structuredClone(equipment), defects: structuredClone(defects), plantVersion,
    signedAt: null, entityLocks: {}, fieldMeta: {}, scenario: null
  }
  rebuildFieldMeta(server, '2026-09-29T18:00:00', '建设单位班组')
  return server
}

export function rebuildFieldMeta(server: ServerState, confirmedAt: string, crew: string) {
  for (const node of server.equipment) {
    for (const item of node.items) {
      for (const field of ITEM_FIELDS) {
        stampMeta(server, itemKey(item.id), field, item.version, { value: item[field], confirmedAt }, crew)
      }
    }
    for (const cert of node.certificates) {
      for (const field of CERT_FIELDS) {
        stampMeta(server, certKey(cert.id), field, cert.version, { value: cert[field], confirmedAt }, crew)
      }
    }
  }
  for (const defect of server.defects) {
    for (const field of DECISION_FIELDS) {
      stampMeta(server, defectKey(defect.id), field, defect.version, { value: defect[field], confirmedAt }, crew)
    }
  }
}

export interface DemoScenario {
  server: ServerState
  equipment: EquipmentNode[]
  defects: AcceptanceDefect[]
  outbox: OutboxRecord[]
}

/**
 * 演示场景：两个班组离线作业、网络恢复后回传。
 * R1 无分歧直接并入；R2 同字段被厂家班组晚确认（本地负）、证据字段分别保留；
 * R3 设备证书失效；R4 缺陷已随签署包锁定（版本不匹配）；R5 处理说明无分歧并入。
 */
export function buildDemoScenario(now: string): DemoScenario {
  const equipment = structuredClone(seedEquipment)
  const defects = structuredClone(seedDefects)
  const server = createFreshServer(equipment, defects, seedPlant.version)

  // 服务端分歧：厂家班组 08:30 修过 IT-T2 实测结果
  const tr1 = server.equipment.find((node) => node.id === 'EQ-TR1')!
  const t2 = tr1.items.find((item) => item.id === 'IT-T2')!
  t2.measured = '更换档位变送器并校准，第7档与监控显示一致'
  t2.version = 3
  stampMeta(server, itemKey('IT-T2'), 'measured', 3, { value: t2.measured, confirmedAt: '2026-10-07T08:30:00' }, '设备厂家班组')

  // 服务端 / 本地一致：逆变器低电压穿越证书已于 09-30 到期
  const inv = server.equipment.find((node) => node.id === 'EQ-INV11')!
  const ci1 = inv.certificates.find((cert) => cert.id === 'C-I1')!
  ci1.expiresAt = '2026-09-30'
  stampMeta(server, certKey('C-I1'), 'expiresAt', ci1.version, { value: ci1.expiresAt, confirmedAt: '2026-09-30T00:00:00' }, '设备厂家班组')
  const localInv = equipment.find((node) => node.id === 'EQ-INV11')!
  localInv.certificates.find((cert) => cert.id === 'C-I1')!.expiresAt = '2026-09-30'

  // 服务端分歧：AD-02 已复验关闭并随签署包 V8 锁定
  const ad02 = server.defects.find((defect) => defect.id === 'AD-260929-02')!
  ad02.status = '已关闭'
  ad02.decisionNote = '第2轮联合复验效率98.62%，随签署包V8关闭'
  ad02.retests.unshift({ round: 2, passed: true, result: '固件更新后复测效率98.62%，满足保证值', tester: '联合验收组', testedAt: '2026-10-06T10:20:00' })
  ad02.version = 5
  stampMeta(server, defectKey(ad02.id), 'status', 5, { value: '已关闭', confirmedAt: '2026-10-06T10:20:00' }, '建设单位班组')
  stampMeta(server, defectKey(ad02.id), 'decisionNote', 5, { value: ad02.decisionNote, confirmedAt: '2026-10-07T08:50:00' }, '建设单位班组')
  server.plantVersion = 8
  server.signedAt = '2026-10-07T08:50:00'
  server.entityLocks[defectKey(ad02.id)] = { version: 5, plantVersion: 8, signedAt: '2026-10-07T08:50:00' }
  server.scenario = 'demo-merge'

  // 本地乐观改动（版本号在回传并入后才由服务端推进）
  const ar1 = equipment.find((node) => node.id === 'EQ-AR1')!
  Object.assign(ar1.items[0], { status: '合格', measured: '30处抽测接地电阻均≤25mΩ', evidence: '接地连续性测试记录.pdf' })

  const localT2 = tr1Local(equipment)
  Object.assign(localT2, { status: '待复验', measured: '就地与远方逐档复测一致', evidence: '档位复测记录-运维单位.pdf' })

  Object.assign(localInv.items[0], { evidence: '点表核对记录-终版签字版.pdf' })

  const localAd01 = defects.find((defect) => defect.id === 'AD-260929-01')!
  localAd01.status = '待联合复验'
  localAd01.replies.unshift({ party: '运维单位', owner: '罗宇', content: '现场配合厂家完成档位变送器更换后的复测，就地远方档位一致。', evidence: '运维复测确认单.pdf', repliedAt: '2026-10-07T07:45:00' })

  const outbox: OutboxRecord[] = [
    record('SYNC-1001', '验收项更新', '建设单位班组', 'EQ-AR1', {
      itemId: 'IT-A1', baseVersion: 1,
      changes: { status: at('合格', '2026-10-07T07:32:00'), measured: at('30处抽测接地电阻均≤25mΩ', '2026-10-07T07:32:00'), evidence: at('接地连续性测试记录.pdf', '2026-10-07T07:32:00') }
    }, now, '2026-10-07T07:32:00'),
    record('SYNC-1002', '验收项更新', '运维单位班组', 'EQ-TR1', {
      itemId: 'IT-T2', baseVersion: 2,
      changes: { status: at('待复验', '2026-10-07T07:40:00'), measured: at('就地与远方逐档复测一致', '2026-10-07T07:40:00'), evidence: at('档位复测记录-运维单位.pdf', '2026-10-07T07:40:00') }
    }, now, '2026-10-07T07:40:00'),
    record('SYNC-1003', '验收项更新', '建设单位班组', 'EQ-INV11', {
      itemId: 'IT-I1', baseVersion: 3,
      changes: { evidence: at('点表核对记录-终版签字版.pdf', '2026-10-07T07:55:00') }
    }, now, '2026-10-07T07:55:00'),
    record('SYNC-1004', '验收决定', '建设单位班组', 'EQ-INV11', {
      defectId: 'AD-260929-02', baseVersion: 3,
      changes: { status: at('已关闭', '2026-10-07T08:00:00'), decisionNote: at('复验合格，同意关闭', '2026-10-07T08:00:00') }
    }, now, '2026-10-07T08:00:00'),
    record('SYNC-1005', '处理说明', '运维单位班组', 'EQ-TR1', {
      defectId: 'AD-260929-01', baseVersion: 4, changes: {},
      reply: { party: '运维单位', owner: '罗宇', content: '现场配合厂家完成档位变送器更换后的复测，就地远方档位一致。', evidence: '运维复测确认单.pdf', repliedAt: '2026-10-07T07:45:00' }
    }, now, '2026-10-07T07:45:00')
  ]

  return { server, equipment, defects, outbox }
}

function tr1Local(equipment: EquipmentNode[]) {
  return equipment.find((node) => node.id === 'EQ-TR1')!.items.find((item) => item.id === 'IT-T2')!
}

function at(value: unknown, confirmedAt: string): FieldChange {
  return { value, confirmedAt }
}

function record(
  id: string, kind: OutboxRecord['kind'], crew: string, equipmentId: string,
  extra: Pick<OutboxRecord, 'baseVersion' | 'changes'> & Partial<Pick<OutboxRecord, 'itemId' | 'defectId' | 'certificateId' | 'reply' | 'retest'>>,
  now: string, confirmedAt: string
): OutboxRecord {
  return {
    id, kind, crew, equipmentId,
    itemId: extra.itemId, defectId: extra.defectId, certificateId: extra.certificateId,
    changes: extra.changes, reply: extra.reply, retest: extra.retest,
    baseVersion: extra.baseVersion, basePlantVersion: 7,
    status: '待回传', attempts: 0, createdAt: now, confirmedAt
  }
}
