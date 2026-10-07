import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { seedAudit, seedDefects, seedEquipment, seedPlant } from '../data/seed'
import type { AcceptanceDefect, AcceptanceItem, AuditEntry, ConflictReason, Crew, EquipmentNode, PartyReply, PendingSyncRecord, Plant } from '../types/domain'
import {
  buildFieldChanges, getCenterSnapshot, getFieldMeta, isOnline, ITEM_FIELDS, mergeReplyUnion,
  networkCall, resetCenterSnapshot, saveSnapshot, scheduleFailures, setOnline,
  simulateCertificateInvalid, simulateCentralSign, simulateOtherCrewItemChange, writeFieldMeta
} from '../services/sync-center'

const STORAGE_KEY = 'gsb67:grid-acceptance'
const CREW_PARTY: Record<Crew, PartyReply['party']> = { 建设班组: '建设单位', 电气班组: '设备厂家', 运维班组: '运维单位' }
export const CREW_OPTIONS: Crew[] = ['建设班组', '电气班组', '运维班组']
let idSeed = 30
let syncSeed = 700

type ActionResult = { ok: boolean; message: string }

interface MergeOutcome {
  outcome: 'merged' | 'conflict'
  reason?: ConflictReason
  detail?: string
}

export const useAcceptanceStore = defineStore('acceptance', () => {
  const plant = ref<Plant>(structuredClone(seedPlant))
  const equipment = ref<EquipmentNode[]>(structuredClone(seedEquipment))
  const defects = ref<AcceptanceDefect[]>(structuredClone(seedDefects))
  const audit = ref<AuditEntry[]>(structuredClone(seedAudit))
  const selectedEquipmentId = ref(equipment.value[0].id)
  const keyword = ref('')
  const hydrated = ref(false)
  const currentCrew = ref<Crew>('电气班组')
  const pendingRecords = ref<PendingSyncRecord[]>([])
  const syncingIds = ref<Set<string>>(new Set())
  const networkOnline = ref(isOnline())

  const selectedEquipment = computed(() => equipment.value.find((item) => item.id === selectedEquipmentId.value))
  const stats = computed(() => {
    const items = equipment.value.flatMap((item) => item.items)
    return {
      total: items.length,
      passed: items.filter((item) => item.status === '合格').length,
      failed: items.filter((item) => item.status === '不合格' || item.status === '待复验').length,
      openDefects: defects.value.filter((item) => !['已关闭', '带条件通过'].includes(item.status)).length
    }
  })

  const pendingCount = computed(() => pendingRecords.value.filter((item) => ['待回传', '回传中', '回传失败'].includes(item.status)).length)
  const failedCount = computed(() => pendingRecords.value.filter((item) => item.status === '回传失败').length)
  const conflictRecords = computed(() => pendingRecords.value.filter((item) => item.status === '冲突待处理'))
  const conflictCount = computed(() => conflictRecords.value.length)
  const frozenCount = computed(() => pendingRecords.value.filter((item) => item.status === '已冻结').length)
  const frozen = computed(() => plant.value.status === '已签署')

  function recordOf(entityId: string) {
    return pendingRecords.value.find((item) => item.entityId === entityId && ['待回传', '回传中', '回传失败', '冲突待处理'].includes(item.status))
  }

  function conflictBlockers(): string[] {
    if (!conflictCount.value) return []
    const lines = conflictRecords.value.map((record) => {
      const cert = record.conflictReason === '证书失效' ? `证书问题：${record.conflictDetail}` : `冲突字段/说明：${record.conflictDetail ?? ''}`
      return `设备「${record.equipmentName}」(${record.equipmentId}) · ${record.entityType === '验收项' ? '验收项' : '缺陷处理说明'}「${record.entityLabel}」 · 原因：${record.conflictReason} · ${cert}`
    })
    return [`存在 ${conflictCount.value} 条未处理回传冲突，完整性检查与签署已暂停，需先在回传中心清空冲突区：`, ...lines]
  }

  const preflight = computed(() => {
    const blocking: string[] = []
    const items = equipment.value.flatMap((item) => item.items)
    if (items.some((item) => item.status === '待检查')) blocking.push('仍有验收项未检查')
    if (items.some((item) => item.status === '不合格' || item.status === '待复验')) blocking.push('存在不合格或待复验项')
    if (defects.value.some((item) => !['已关闭', '带条件通过'].includes(item.status))) blocking.push('存在未闭环缺陷')
    if (equipment.value.flatMap((item) => item.certificates).some((item) => !item.verified)) blocking.push('存在未核验证书')
    const expired = equipment.value.flatMap((item) => item.certificates).some((item) => item.expiresAt < plant.value.commissioningDate)
    if (expired) blocking.push('证书在并网日期前失效')
    blocking.unshift(...conflictBlockers())
    return { allowed: blocking.length === 0, blocking }
  })

  function hydrate() {
    if (!import.meta.client || hydrated.value) return
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const stored = JSON.parse(raw)
        plant.value = stored.plant
        equipment.value = stored.equipment
        defects.value = stored.defects
        audit.value = stored.audit
        pendingRecords.value = (stored.pendingRecords ?? []).map((record: PendingSyncRecord) =>
          record.status === '回传中' ? { ...record, status: '待回传' } : record
        )
        syncSeed = pendingRecords.value.reduce((max, record) => {
          const matched = /^SYNC-(\d+)$/.exec(record.id)
          return matched ? Math.max(max, Number(matched[1])) : max
        }, syncSeed)
        if (stored.currentCrew) currentCrew.value = stored.currentCrew
      }
    } catch {
      // Seed data is kept when browser storage is corrupt.
    }
    getCenterSnapshot({ plant: plant.value, equipment: equipment.value, defects: defects.value })
    hydrated.value = true
  }

  function persist() {
    if (!import.meta.client) return
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      plant: plant.value, equipment: equipment.value, defects: defects.value, audit: audit.value,
      pendingRecords: pendingRecords.value, currentCrew: currentCrew.value
    }))
  }

  function equipmentName(equipmentId: string) {
    return equipment.value.find((node) => node.id === equipmentId)?.name ?? equipmentId
  }

  function setCrew(crew: Crew) {
    currentCrew.value = crew
    persist()
  }

  function toggleNetwork(online: boolean) {
    // 通过中心服务切换网络通道；恢复联网后自动合并待回传记录
    setOnline(online)
    networkOnline.value = online
    if (online) void autoSync()
  }

  function simulateNextFailure() {
    scheduleFailures(1)
  }

  function updateItem(equipmentId: string, itemId: string, patch: Partial<AcceptanceItem>): ActionResult {
    if (frozen.value) return { ok: false, message: '交付版本已签署锁定，回传记录已冻结，不能再录入验收项' }
    const node = equipment.value.find((value) => value.id === equipmentId)
    const item = node?.items.find((value) => value.id === itemId)
    if (!node || !item) return { ok: false, message: '验收项不存在' }
    const confirmedAt = new Date().toISOString()
    const current: Record<string, string> = {
      status: item.status, measured: item.measured, evidence: item.evidence, condition: item.condition
    }
    const picked: Record<string, string> = {}
    ITEM_FIELDS.forEach(({ field }) => {
      const value = (patch as Record<string, unknown>)[field]
      if (value !== undefined) picked[field] = String(value)
    })
    const next = { ...current, ...picked }
    const changes = buildFieldChanges(equipmentId, itemId, current, next, confirmedAt)
    if (!changes.length) return { ok: false, message: '内容未变化' }
    const baseVersion = item.version
    Object.assign(item, picked, { version: baseVersion + 1 })
    enqueueItemRecord(node, item, changes, baseVersion, confirmedAt)
    log(equipmentId, '更新验收项', currentCrew.value, `${item.id}状态更新为${item.status}`)
    persist()
    void autoSync()
    return { ok: true, message: isOnline() ? '已确认并回传，网络恢复前可继续录入' : '当前断网：已存入待回传队列，网络恢复后按确认时间合并' }
  }

  function enqueueItemRecord(node: EquipmentNode, item: AcceptanceItem, changes: ReturnType<typeof buildFieldChanges>, baseVersion: number, confirmedAt: string) {
    const existing = pendingRecords.value.find((record) =>
      record.entityId === item.id && record.crew === currentCrew.value && ['待回传', '回传失败'].includes(record.status))
    if (existing) {
      for (const change of changes) {
        const old = existing.fields.find((field) => field.field === change.field)
        if (old) { old.localValue = change.localValue; old.localConfirmedAt = confirmedAt } else { existing.fields.push(change) }
      }
      existing.confirmedAt = confirmedAt
      existing.status = '待回传'
      existing.lastError = ''
      return
    }
    pendingRecords.value.unshift({
      id: `SYNC-${++syncSeed}`,
      entityType: '验收项',
      equipmentId: node.id,
      equipmentName: node.name,
      entityId: item.id,
      itemId: item.id,
      entityLabel: item.standard,
      crew: currentCrew.value,
      fields: changes,
      replies: [],
      baseVersion,
      basePlantVersion: plant.value.version,
      status: '待回传',
      lastError: '',
      attempts: 0,
      createdAt: confirmedAt,
      confirmedAt
    })
  }

  function assignDefect(id: string, owner: string) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return
    defect.owner = owner
    defect.status = '整改中'
    defect.version += 1
    log(id, '分派缺陷', '验收负责人', `责任方调整为${owner}`)
    persist()
  }

  function addReply(id: string, reply: PartyReply): ActionResult {
    if (frozen.value) return { ok: false, message: '交付版本已签署锁定，回传记录已冻结，不能再提交处理说明' }
    const defect = defects.value.find((item) => item.id === id)
    if (!defect || !reply.content || !reply.evidence) return { ok: false, message: '回复内容和证据均不能为空' }
    const confirmedAt = new Date().toISOString()
    const stamped = { ...reply, repliedAt: confirmedAt }
    const baseVersion = defect.version
    defect.replies.unshift(stamped)
    defect.status = '待联合复验'
    defect.version += 1
    enqueueDefectRecord(defect, stamped, baseVersion, confirmedAt)
    log(id, `${reply.party}提交处理说明`, reply.owner, reply.content)
    persist()
    void autoSync()
    return { ok: true, message: isOnline() ? '处理说明已回传中心' : '当前断网：处理说明已进入待回传队列，联网后合并' }
  }

  function enqueueDefectRecord(defect: AcceptanceDefect, reply: PartyReply, baseVersion: number, confirmedAt: string) {
    const existing = pendingRecords.value.find((record) =>
      record.entityId === defect.id && record.crew === currentCrew.value && ['待回传', '回传失败'].includes(record.status))
    if (existing) {
      if (!existing.replies.some((item) => item.repliedAt === reply.repliedAt)) existing.replies.push(reply)
      existing.confirmedAt = confirmedAt
      existing.status = '待回传'
      existing.lastError = ''
      return
    }
    pendingRecords.value.unshift({
      id: `SYNC-${++syncSeed}`,
      entityType: '缺陷处理说明',
      equipmentId: defect.equipmentId,
      equipmentName: equipmentName(defect.equipmentId),
      entityId: defect.id,
      itemId: defect.itemId,
      entityLabel: defect.title,
      crew: currentCrew.value,
      fields: [],
      replies: [reply],
      baseVersion,
      basePlantVersion: plant.value.version,
      status: '待回传',
      lastError: '',
      attempts: 0,
      createdAt: confirmedAt,
      confirmedAt
    })
  }

  function addRetest(id: string, result: string, passed: boolean) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return
    defect.retests.unshift({ round: defect.retests.length + 1, passed, result, tester: '联合验收组', testedAt: new Date().toISOString() })
    defect.status = passed ? '已关闭' : '整改中'
    defect.version += 1
    log(id, '执行联合复验', '联合验收组', result)
    persist()
  }

  function decideDefect(id: string, status: '已关闭' | '带条件通过' | '整改中', note: string): ActionResult {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    if (status === '已关闭' && !defect.retests.some((item) => item.passed)) return { ok: false, message: '没有合格复验记录，不能关闭' }
    if (status === '带条件通过' && !note.trim()) return { ok: false, message: '带条件通过必须说明限制条件' }
    defect.status = status
    defect.decisionNote = note
    defect.version += 1
    log(id, `验收决定：${status}`, '验收负责人', note || '完成整改闭环')
    persist()
    return { ok: true, message: `缺陷已更新为${status}` }
  }

  function time(value?: string) {
    return value ? value.replace('T', ' ').slice(0, 16) : '—'
  }

  function itemField(item: AcceptanceItem, field: string): string {
    return String((item as unknown as Record<string, unknown>)[field] ?? '')
  }

  function setItemField(item: AcceptanceItem, field: string, value: string) {
    ;(item as unknown as Record<string, string>)[field] = value
  }

  // 在中心快照上评估一条记录：不同字段分别保留；同字段按最后确认时间处理；
  // 其他班组后确认、证书失效或签署版本不匹配则进入冲突区，不动本地原记录。
  function evaluateOnCenter(record: PendingSyncRecord, force: boolean): MergeOutcome {
    const snapshot = getCenterSnapshot({ plant: plant.value, equipment: equipment.value, defects: defects.value })

    if (snapshot.plant.status === '已签署' && snapshot.plant.version > record.basePlantVersion) {
      return {
        outcome: 'conflict', reason: '签署版本不匹配',
        detail: `中心已签署锁定 V${snapshot.plant.version}，本班记录基于验收中的 V${record.basePlantVersion}，需撤回中心签署后重试`
      }
    }

    const node = snapshot.equipment.find((value) => value.id === record.equipmentId)
    const badCertificates = node?.certificates.filter((certificate) => !certificate.verified || certificate.expiresAt < snapshot.plant.commissioningDate) ?? []
    if (badCertificates.length) {
      return {
        outcome: 'conflict', reason: '证书失效',
        detail: badCertificates.map((certificate) =>
          `「${certificate.name}」(${certificate.id}) ${!certificate.verified ? '核验被撤销' : `有效期仅至${certificate.expiresAt}`}`).join('；')
      }
    }

    if (record.entityType === '验收项') return evaluateItem(record, snapshot, force)
    return evaluateDefect(record, snapshot)
  }

  function evaluateItem(record: PendingSyncRecord, snapshot: ReturnType<typeof getCenterSnapshot>, force: boolean): MergeOutcome {
    const node = snapshot.equipment.find((value) => value.id === record.equipmentId)
    const centralItem = node?.items.find((value) => value.id === record.entityId)
    if (!node || !centralItem) {
      return { outcome: 'conflict', reason: '被其他班组改过', detail: '中心端已找不到该验收项，可能被其他班组调整结构' }
    }
    const overlapping: string[] = []
    for (const change of record.fields) {
      const meta = getFieldMeta(snapshot, node.id, centralItem.id, change.field)
      change.centralValue = itemField(centralItem, change.field)
      if (meta && meta.value !== change.baseValue) {
        change.centralConfirmedAt = meta.confirmedAt
        change.centralCrew = meta.crew
        const centralLater = change.localConfirmedAt <= meta.confirmedAt
        if (change.centralValue !== change.localValue && centralLater && !force) {
          overlapping.push(`${change.fieldLabel}：${meta.crew}于${time(meta.confirmedAt)}确认为「${change.centralValue}」，本班于${time(change.localConfirmedAt)}确认为「${change.localValue}」`)
        }
      }
    }
    if (overlapping.length) {
      return { outcome: 'conflict', reason: '被其他班组改过', detail: overlapping.join('；') }
    }

    const localNode = equipment.value.find((value) => value.id === node.id)!
    const localItem = localNode.items.find((value) => value.id === centralItem.id)!
    const localWon = record.fields.filter((change) => change.centralValue !== change.localValue)
    const pulled = ITEM_FIELDS
      .filter(({ field }) => !record.fields.some((change) => change.field === field))
      .filter(({ field }) => {
        const meta = getFieldMeta(snapshot, node.id, centralItem.id, field)
        return meta && itemField(localItem, field) !== itemField(centralItem, field)
      })
      .map(({ label }) => label)

    for (const change of record.fields) {
      setItemField(centralItem, change.field, change.localValue)
      writeFieldMeta(snapshot, node.id, centralItem.id, change.field, change.localValue, change.localConfirmedAt, record.crew)
    }
    centralItem.version = Math.max(centralItem.version, record.baseVersion) + 1
    saveSnapshot(snapshot)

    // 合并结果回灌本地：本班字段与其他班组分头修改的字段同时保留
    const merged = structuredClone(centralItem)
    Object.assign(localItem, merged)

    const parts: string[] = []
    if (localWon.length) parts.push(`本班最后确认的字段[${localWon.map((item) => item.fieldLabel).join('、')}]覆盖中心`)
    if (pulled.length) parts.push(`自动保留其他班组修改的字段[${pulled.join('、')}]`)
    log(centralItem.id, '回传合并', record.crew, `设备${node.name}：${parts.join('；') || '内容一致，直接并入'}，版本升至V${centralItem.version}`)
    return { outcome: 'merged' }
  }

  function evaluateDefect(record: PendingSyncRecord, snapshot: ReturnType<typeof getCenterSnapshot>): MergeOutcome {
    const centralDefect = snapshot.defects.find((value) => value.id === record.entityId)
    const localDefect = defects.value.find((value) => value.id === record.entityId)
    if (!centralDefect || !localDefect) {
      return { outcome: 'conflict', reason: '被其他班组改过', detail: '中心端已找不到该缺陷记录' }
    }
    for (const reply of record.replies) {
      const clash = centralDefect.replies.find((item) => item.party === reply.party && item.repliedAt === reply.repliedAt && item.content !== reply.content)
      if (clash) {
        return { outcome: 'conflict', reason: '被其他班组改过', detail: `${reply.party}在同一时间点(${time(reply.repliedAt)})的处理说明内容不一致` }
      }
    }
    const pulled: string[] = []
    if (centralDefect.status !== localDefect.status) pulled.push(`状态改为「${centralDefect.status}」`)
    if (centralDefect.owner !== localDefect.owner) pulled.push(`责任方改为「${centralDefect.owner}」`)

    centralDefect.replies = mergeReplyUnion(localDefect.replies, centralDefect.replies)
    centralDefect.version = Math.max(centralDefect.version, record.baseVersion) + 1
    saveSnapshot(snapshot)

    Object.assign(localDefect, structuredClone(centralDefect))
    log(centralDefect.id, '回传合并', record.crew, `设备${record.equipmentName}：处理说明并入，版本升至V${centralDefect.version}${pulled.length ? `；同时保留其他班组的调整（${pulled.join('，')}）` : ''}`)
    return { outcome: 'merged' }
  }

  async function syncRecord(id: string, force = false): Promise<ActionResult> {
    const record = pendingRecords.value.find((item) => item.id === id)
    if (!record) return { ok: false, message: '记录不存在' }
    if (record.status === '已冻结') return { ok: false, message: '记录已随签署冻结，不能再回传' }
    if (record.status === '已回传') return { ok: false, message: '该记录已完成回传' }
    if (syncingIds.value.has(id)) return { ok: false, message: '正在回传中' }
    syncingIds.value.add(id)
    record.status = '回传中'
    record.lastError = ''
    try {
      const outcome = await networkEvaluate(record, force)
      record.attempts += 1
      if (outcome.outcome === 'conflict') {
        record.status = '冲突待处理'
        record.conflictReason = outcome.reason
        record.conflictDetail = outcome.detail
        log(record.entityId, '回传冲突进入冲突区', record.crew, `设备${record.equipmentName}：${outcome.reason}（${outcome.detail}）`)
        persist()
        return { ok: false, message: `进入冲突区：${outcome.reason}` }
      }
      record.status = '已回传'
      record.conflictReason = undefined
      record.conflictDetail = undefined
      record.syncedAt = new Date().toISOString()
      if (force) record.resolutionNote = '已按本班最新确认时间重新确认并保留'
      persist()
      return { ok: true, message: '回传成功，已与中心记录合并' }
    } catch (error) {
      record.attempts += 1
      record.lastError = error instanceof Error ? error.message : '回传失败'
      // 失败后保留原记录：冲突记录仍留在冲突区，其余回到待回传/失败状态
      record.status = record.conflictReason ? '冲突待处理' : '回传失败'
      persist()
      return { ok: false, message: record.lastError }
    } finally {
      syncingIds.value.delete(id)
    }
  }

  function networkEvaluate(record: PendingSyncRecord, force: boolean): Promise<MergeOutcome> {
    // 中心服务的网络通道：断网或网关故障时 reject，记录原样保留。
    return networkCall(() => evaluateOnCenter(record, force))
  }

  async function autoSync() {
    if (!isOnline() || frozen.value) return
    const target = pendingRecords.value.find((item) => item.status === '待回传')
    if (target) await syncRecord(target.id)
    const next = pendingRecords.value.find((item) => item.status === '待回传')
    if (next) void autoSync()
  }

  async function syncAllPending(): Promise<{ merged: number; failed: number; conflict: number }> {
    const result = { merged: 0, failed: 0, conflict: 0 }
    let target = pendingRecords.value.find((item) => ['待回传', '回传失败'].includes(item.status))
    while (target) {
      const id = target.id
      const outcome = await syncRecord(id)
      if (outcome.ok) result.merged += 1
      else {
        const current = pendingRecords.value.find((item) => item.id === id)
        if (current?.status === '冲突待处理') result.conflict += 1
        else result.failed += 1
      }
      target = pendingRecords.value.find((item) => ['待回传', '回传失败'].includes(item.status))
    }
    return result
  }

  async function retryRecord(id: string) {
    const record = pendingRecords.value.find((item) => item.id === id)
    if (!record) return { ok: false, message: '记录不存在' }
    return await syncRecord(id)
  }

  async function resolveConflict(id: string, action: 'adopt-central' | 'keep-local'): Promise<ActionResult> {
    const record = pendingRecords.value.find((item) => item.id === id)
    if (!record) return { ok: false, message: '冲突记录不存在' }
    if (record.status !== '冲突待处理') return { ok: false, message: '该记录不在冲突区' }
    if (action === 'adopt-central') {
      const snapshot = getCenterSnapshot({ plant: plant.value, equipment: equipment.value, defects: defects.value })
      if (record.entityType === '验收项') {
        const centralItem = snapshot.equipment.find((node) => node.id === record.equipmentId)?.items.find((item) => item.id === record.entityId)
        const localItem = equipment.value.find((node) => node.id === record.equipmentId)?.items.find((item) => item.id === record.entityId)
        if (!centralItem || !localItem) return { ok: false, message: '中心或本地记录缺失，无法采用中心版本' }
        Object.assign(localItem, structuredClone(centralItem))
      } else {
        const centralDefect = snapshot.defects.find((item) => item.id === record.entityId)
        const localDefect = defects.value.find((item) => item.id === record.entityId)
        if (!centralDefect || !localDefect) return { ok: false, message: '中心或本地记录缺失，无法采用中心版本' }
        Object.assign(localDefect, structuredClone(centralDefect))
      }
      record.status = '已回传'
      record.resolutionNote = '冲突已按中心版本处理（采用其他班组数据）'
      record.syncedAt = new Date().toISOString()
      log(record.entityId, '冲突解决', record.crew, `设备${record.equipmentName}：采用中心版本覆盖本班待回传内容`)
      persist()
      return { ok: true, message: '已采用中心版本，冲突清除' }
    }
    if (!isOnline()) return { ok: false, message: '当前断网，无法重新确认回传，记录保留在冲突区' }
    record.fields.forEach((field) => { field.localConfirmedAt = new Date().toISOString() })
    record.confirmedAt = new Date().toISOString()
    record.conflictReason = undefined
    record.conflictDetail = undefined
    const result = await syncRecord(id, true)
    if (!result.ok && record.status !== '冲突待处理') return result
    if (record.status === '冲突待处理') return { ok: false, message: '重新确认后仍存在冲突，请改用中心版本或稍后重试' }
    return { ok: true, message: '已按本班最新确认时间合并，冲突清除' }
  }

  function signOff(): ActionResult {
    if (frozen.value) return { ok: false, message: '交付版本已签署并冻结' }
    if (conflictCount.value > 0) {
      return { ok: false, message: `回传冲突区仍有${conflictCount.value}条记录未清空，完整性检查与签署已暂停` }
    }
    if (!preflight.value.allowed) return { ok: false, message: preflight.value.blocking.join('；') }
    plant.value.status = '已签署'
    plant.value.version += 1
    equipment.value.forEach((node) => { node.status = '已验收' })
    const frozenAt = new Date().toISOString()
    pendingRecords.value.forEach((record) => {
      record.status = '已冻结'
      record.frozenAt = frozenAt
      if (!record.syncedAt) record.lastError = record.lastError || '签署时仍未完成回传，记录冻结留存'
    })
    log(plant.value.id, '签署交付版本', '验收负责人陆川', `锁定V${plant.value.version}并生成交付包，${pendingRecords.value.length}条回传记录同步冻结`)
    persist()
    return { ok: true, message: '签署完成，交付版本与全部回传记录已冻结' }
  }

  function reset() {
    plant.value = structuredClone(seedPlant)
    equipment.value = structuredClone(seedEquipment)
    defects.value = structuredClone(seedDefects)
    audit.value = structuredClone(seedAudit)
    pendingRecords.value = []
    currentCrew.value = '电气班组'
    resetCenterSnapshot({ plant: seedPlant, equipment: seedEquipment, defects: seedDefects })
    persist()
  }

  function log(entityId: string, action: string, operator: string, detail: string) {
    audit.value.unshift({ id: `AUD-${Date.now()}-${idSeed++}`, entityId, action, operator, detail, createdAt: new Date().toISOString() })
  }

  return {
    plant, equipment, defects, audit, selectedEquipmentId, keyword, hydrated, currentCrew,
    pendingRecords, syncingIds, networkOnline, selectedEquipment, stats, preflight,
    pendingCount, failedCount, conflictRecords, conflictCount, frozenCount, frozen,
    hydrate, persist, setCrew, toggleNetwork, simulateNextFailure, recordOf,
    updateItem, assignDefect, addReply, addRetest, decideDefect,
    syncRecord, syncAllPending, retryRecord, resolveConflict,
    signOff, reset, log,
    simulateOtherCrew: (equipmentId: string, itemId: string, field: string, value: string, crew: Crew) =>
      simulateOtherCrewItemChange(equipmentId, itemId, field, value, crew),
    simulateCertificate: (equipmentId: string, certificateId: string, expiresAt: string, verified: boolean) =>
      simulateCertificateInvalid(equipmentId, certificateId, expiresAt, verified),
    simulateCentralSign: (version: number) => simulateCentralSign(version),
    CREW_PARTY
  }
})
