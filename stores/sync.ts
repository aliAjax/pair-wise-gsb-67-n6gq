import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useAcceptanceStore } from './acceptance'
import {
  buildDemoScenario, certKey, createFreshServer, defectKey, findCert, findItem,
  itemKey, mergeRecord, resolveOverlapByTime, type ServerState
} from '../services/sync-engine'
import type {
  AcceptanceDefect, AcceptanceItem, Certificate, ChangeDescriptor, EquipmentNode, OutboxRecord, SyncConflict
} from '../types/domain'

const SYNC_STORAGE_KEY = 'gsb67:sync'
const SERVER_STORAGE_KEY = 'gsb67:remote-server'
let syncIdSeed = 2000

export type ConflictResolution = '按时间合并' | '采用服务端版本' | '放弃本班记录' | '证书续期' | '重定基线'

interface SyncPersistShape {
  online: boolean
  crew: string
  records: OutboxRecord[]
  serverFailures: boolean
}

export const useSyncStore = defineStore('sync', () => {
  const online = ref(true)
  const crew = ref('建设单位班组')
  const serverFailures = ref(false)
  const records = ref<OutboxRecord[]>([])
  const server = ref<ServerState | null>(null)
  const hydrated = ref(false)
  const lastSyncAt = ref<string | null>(null)
  const syncNotice = ref('')

  const pendingRecords = computed(() => records.value.filter((item) => item.status === '待回传' || item.status === '失败'))
  const conflictRecords = computed(() => records.value.filter((item) => item.status === '冲突'))
  const mergedRecords = computed(() => records.value.filter((item) => item.status === '已回传' || item.status === '已冻结' || item.status === '已放弃'))
  const hasConflicts = computed(() => conflictRecords.value.length > 0)
  const hasPending = computed(() => pendingRecords.value.length > 0)
  const frozen = computed(() => useAcceptanceStore().plant.status === '已签署')

  const stats = computed(() => ({
    pending: pendingRecords.value.length,
    conflicts: conflictRecords.value.length,
    merged: records.value.filter((item) => item.status === '已回传' || item.status === '已冻结').length,
    failed: records.value.filter((item) => item.status === '失败').length
  }))

  /** 冲突未清前，完整性检查与签署必须停住；此处逐条说明设备、验收项/缺陷与证书。 */
  const conflictBlockers = computed<string[]>(() => conflictRecords.value.map((item) => describeConflict(item.conflict!)))

  function describeConflict(conflict: SyncConflict) {
    const where = `${conflict.equipmentName}（${conflict.equipmentCode}）· ${conflict.targetLabel}`
    if (conflict.type === '证书失效') {
      const certs = conflict.certificates.map((cert) => `${cert.name}，有效期至${cert.expiresAt}`).join('；')
      return `【${conflict.type}】${where}：${certs}`
    }
    if (conflict.type === '签署版本不匹配') {
      return `【${conflict.type}】${where}：记录依据 V${conflict.baseVersion}，已签署锁定 V${conflict.signedVersion}`
    }
    const fields = conflict.fields.join('、')
    return `【${conflict.type}】${where}：${fields || '记录'} 被 ${conflict.remoteCrew} 改动（服务端 V${conflict.serverVersion}，确认于 ${conflict.remoteConfirmedAt?.replace('T', ' ').slice(0, 16)}）`
  }

  function hydrate() {
    if (!import.meta.client || hydrated.value) return
    try {
      const raw = localStorage.getItem(SYNC_STORAGE_KEY)
      if (raw) {
        const stored = JSON.parse(raw) as SyncPersistShape
        online.value = stored.online
        crew.value = stored.crew
        records.value = stored.records ?? []
        serverFailures.value = stored.serverFailures ?? false
      }
      const serverRaw = localStorage.getItem(SERVER_STORAGE_KEY)
      if (serverRaw) server.value = JSON.parse(serverRaw) as ServerState
    } catch {
      // 损坏的回传缓存不阻断应用启动，使用全新服务端快照。
    }
    ensureServer()
    hydrated.value = true
  }

  function ensureServer(): ServerState {
    if (server.value) return server.value
    const acceptance = useAcceptanceStore()
    server.value = createFreshServer(acceptance.equipment, acceptance.defects, acceptance.plant.version)
    persistServer()
    return server.value
  }

  function persistSync() {
    if (!import.meta.client) return
    const payload: SyncPersistShape = { online: online.value, crew: crew.value, records: records.value, serverFailures: serverFailures.value }
    localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify(payload))
  }

  function persistServer() {
    if (!import.meta.client || !server.value) return
    localStorage.setItem(SERVER_STORAGE_KEY, JSON.stringify(server.value))
  }

  function setCrew(value: string) {
    crew.value = value
    persistSync()
  }

  function setOnline(value: boolean) {
    online.value = value
    persistSync()
    if (value) {
      void flushPending('网络恢复，已自动合并待回传记录')
    }
  }

  function toggleServerFailures(value: boolean) {
    serverFailures.value = value
    persistSync()
  }

  /** 业务变更统一走入队入口：离线乐观写入本地，联网时立即回传并入。 */
  function enqueue(descriptor: ChangeDescriptor): { ok: boolean; message: string } {
    if (frozen.value) return { ok: false, message: '已签署锁定，回传记录冻结，不能再提交' }
    const acceptance = useAcceptanceStore()
    const confirmedAt = latestConfirmedAt(descriptor)
    const record: OutboxRecord = {
      id: `SYNC-${syncIdSeed++}`,
      kind: descriptor.kind,
      crew: crew.value,
      equipmentId: descriptor.equipmentId,
      itemId: descriptor.itemId,
      defectId: descriptor.defectId,
      certificateId: descriptor.certificateId,
      changes: descriptor.changes,
      reply: descriptor.reply,
      retest: descriptor.retest,
      baseVersion: descriptor.baseVersion,
      basePlantVersion: acceptance.plant.version,
      status: '待回传',
      attempts: 0,
      createdAt: new Date().toISOString(),
      confirmedAt
    }
    records.value.unshift(record)
    persistSync()
    if (online.value) void flushFor(record.id, '变更已实时回传')
    return { ok: true, message: online.value ? '已提交并回传' : '已离线暂存，网络恢复后回传' }
  }

  function latestConfirmedAt(descriptor: ChangeDescriptor) {
    const times = Object.values(descriptor.changes).map((item) => item.confirmedAt)
    if (descriptor.reply) times.push(descriptor.reply.repliedAt)
    if (descriptor.retest) times.push(descriptor.retest.testedAt)
    times.push(new Date().toISOString())
    return times.sort().at(-1)!
  }

  function refreshIdSeed() {
    const max = records.value.reduce((acc, item) => {
      const num = Number(item.id.replace('SYNC-', ''))
      return Number.isFinite(num) ? Math.max(acc, num) : acc
    }, 2000)
    syncIdSeed = max + 1
  }

  /** 网络恢复后合并全部待回传/失败记录。失败的记录原样保留，可重试。 */
  async function flushPending(notice?: string) {
    hydrate()
    if (!online.value) return { ok: false, message: '当前处于断网状态，待回传记录将保留' }
    const targets = records.value.filter((item) => item.status === '待回传' || item.status === '失败')
    for (const target of targets) await flushFor(target.id)
    if (targets.length && notice) syncNotice.value = notice
    lastSyncAt.value = new Date().toISOString()
    persistSync()
    return { ok: true }
  }

  async function retryRecord(id: string) {
    if (!online.value) return { ok: false, message: '仍处断网状态，无法重试' }
    const record = records.value.find((item) => item.id === id)
    if (!record) return { ok: false, message: '记录不存在' }
    record.status = '待回传'
    record.error = undefined
    return flushFor(id, '重试完成')
  }

  async function flushFor(id: string, notice?: string) {
    hydrate()
    const target = records.value.find((item) => item.id === id)
    if (!target) return { ok: false, message: '记录不存在' }
    if (!online.value) return { ok: false, message: '网络未恢复，记录保留在待回传区' }
    const acceptance = useAcceptanceStore()

    // 模拟回传通道故障：不改动记录内容，仅累计尝试次数，允许稍后重试。
    if (serverFailures.value) {
      target.attempts += 1
      target.status = '失败'
      target.error = '回传通道不可用（模拟服务端故障），原记录已保留，可重试'
      acceptance.log(target.equipmentId, '回传失败', target.crew, target.error)
      persistSync()
      return { ok: false, message: target.error }
    }

    const current = ensureServer()
    const result = mergeRecord(target, { server: current, commissioningDate: acceptance.plant.commissioningDate, now: new Date().toISOString() })
    server.value = result.server
    persistServer()
    Object.assign(target, {
      status: result.record.status, attempts: result.record.attempts,
      conflict: result.record.conflict, error: result.record.error, mergedAt: result.record.mergedAt
    })

    // 仅无冲突/无失败的并入结果回写本地工作区；冲突记录保持原值等待处理。
    if (target.status === '已回传') {
      for (const equipmentId of result.equipmentTouched) adoptEquipment(equipmentId)
      for (const defectId of result.defectsTouched) adoptDefect(defectId)
      acceptance.log(target.equipmentId, '回传并入', target.crew, `${target.kind}已合并${describeTouch(result)}`)
    } else if (target.status === '冲突') {
      acceptance.log(target.equipmentId, '回传进入冲突区', target.crew, describeConflict(target.conflict!))
    }

    acceptance.persist()
    if (notice) syncNotice.value = notice
    lastSyncAt.value = new Date().toISOString()
    persistSync()
    return { ok: true, status: target.status }
  }

  function describeTouch(result: { equipmentTouched: string[]; defectsTouched: string[] }) {
    const parts: string[] = []
    if (result.equipmentTouched.length) parts.push(`设备${result.equipmentTouched.join('、')}`)
    if (result.defectsTouched.length) parts.push(`缺陷${result.defectsTouched.join('、')}`)
    return parts.length ? `（${parts.join('；')}）` : ''
  }

  /** 将服务端已并入的实体按 id 拉回本地；不同字段在合并时已分别保留。 */
  function adoptEquipment(equipmentId: string) {
    adoptEquipmentImpl(equipmentId, false)
  }

  /** 冲突处理（采用服务端/放弃/按时间合并）后，强制以最终实体覆盖本地。 */
  function adoptEquipmentForce(equipmentId: string) {
    adoptEquipmentImpl(equipmentId, true)
  }

  function adoptEquipmentImpl(equipmentId: string, force: boolean) {
    const acceptance = useAcceptanceStore()
    const remote = server.value?.equipment.find((node) => node.id === equipmentId)
    const local = acceptance.equipment.find((node) => node.id === equipmentId)
    if (!remote || !local) return
    // 自动并入时，本地存在其他未解决冲突的验收项保留本地乐观值，避免覆盖待决数据。
    const unresolvedItemIds = new Set(conflictRecords.value
      .filter((item) => item.equipmentId === equipmentId && item.kind === '验收项更新')
      .map((item) => item.itemId))
    const unresolvedCertIds = new Set(conflictRecords.value
      .filter((item) => item.equipmentId === equipmentId && item.kind === '证书更新')
      .map((item) => item.certificateId))
    for (const remoteItem of remote.items) {
      const localItem = local.items.find((item) => item.id === remoteItem.id)
      if (localItem && (force || !unresolvedItemIds.has(remoteItem.id))) Object.assign(localItem, structuredClone(remoteItem))
    }
    for (const remoteCert of remote.certificates) {
      const localCert = local.certificates.find((cert) => cert.id === remoteCert.id)
      if (localCert && (force || !unresolvedCertIds.has(remoteCert.id))) Object.assign(localCert, structuredClone(remoteCert))
    }
    local.status = remote.status
  }

  function adoptDefect(defectId: string) {
    const acceptance = useAcceptanceStore()
    const remote = server.value?.defects.find((item) => item.id === defectId)
    const local = acceptance.defects.find((item) => item.id === defectId)
    // 该缺陷仍有冲突记录待处理时保留本地乐观值，由冲突处理流程最终覆盖。
    const hasUnresolved = conflictRecords.value.some((item) => item.defectId === defectId)
    if (remote && local && !hasUnresolved) Object.assign(local, structuredClone(remote))
  }

  /** 冲突区处理：确认时间合并 / 采用服务端 / 放弃 / 证书续期 / 重定基线后重试。 */
  async function resolveConflict(id: string, action: ConflictResolution, certExpiresAt?: string) {
    const target = records.value.find((item) => item.id === id)
    if (!target?.conflict) return { ok: false, message: '冲突记录不存在' }
    const acceptance = useAcceptanceStore()
    ensureServer()

    if (action === '放弃本班记录') {
      target.status = '已放弃'
      target.conflict = undefined
      target.resolvedNote = '放弃本班记录，保留其他班组版本'
      // 放弃后以服务端版本覆盖本地乐观值
      if (target.equipmentId) adoptEquipmentForce(target.equipmentId)
      if (target.defectId) adoptDefect(target.defectId)
      acceptance.log(target.equipmentId, '冲突处理：放弃', target.crew, `${target.kind}未并入，已采用服务端版本`)
      finishResolve()
      return { ok: true, message: '已放弃本班记录，完整性检查阻断解除' }
    }

    if (action === '采用服务端版本') {
      target.status = '已回传'
      target.conflict = undefined
      target.resolvedNote = '确认采用其他班组版本'
      target.mergedAt = new Date().toISOString()
      if (target.equipmentId) adoptEquipmentForce(target.equipmentId)
      if (target.defectId) adoptDefect(target.defectId)
      acceptance.log(target.equipmentId, '冲突处理：采用服务端', target.crew, target.resolvedNote)
      finishResolve()
      return { ok: true, message: '已采用服务端版本' }
    }

    if (action === '按时间合并') {
      server.value = resolveOverlapByTime(server.value!, target, new Date().toISOString())
      persistServer()
      target.status = '已回传'
      target.resolvedNote = '同字段按最后确认时间合并，不同字段分别保留'
      target.mergedAt = new Date().toISOString()
      if (target.equipmentId) adoptEquipmentForce(target.equipmentId)
      if (target.defectId) adoptDefect(target.defectId)
      acceptance.log(target.equipmentId, '冲突处理：按时间合并', target.crew, target.resolvedNote)
      finishResolve()
      return { ok: true, message: '已按最后确认时间完成合并' }
    }

    if (action === '证书续期') {
      if (!certExpiresAt) return { ok: false, message: '请填写续期后的有效期' }
      const certs = target.conflict.certificates
      for (const ref of certs) {
        patchCertificateAll(ref.id, { expiresAt: certExpiresAt, verified: true })
      }
      acceptance.log(target.equipmentId, '冲突处理：证书续期', target.crew, `证书有效期更新至${certExpiresAt}并通过核验`)
      return retryRecord(id)
    }

    if (action === '重定基线') {
      // 以当前（已签署）版本为基线重新提交，随后立即合并
      if (target.kind === '验收项更新' || target.kind === '证书更新') {
        const hit = target.kind === '证书更新'
          ? findCert(server.value!, target.equipmentId, target.certificateId).certificate
          : findItem(server.value!, target.equipmentId, target.itemId).item
        if (hit) target.baseVersion = hit.version
      } else {
        const defect = server.value?.defects.find((item) => item.id === target.defectId)
        if (defect) target.baseVersion = defect.version
      }
      acceptance.log(target.equipmentId, '冲突处理：重定基线', target.crew, `以签署后当前版本为基线重新回传`)
      return retryRecord(id)
    }

    return { ok: false, message: '未知处理方式' }
  }

  function finishResolve() {
    lastSyncAt.value = new Date().toISOString()
    useAcceptanceStore().persist()
    persistSync()
  }

  function patchCertificateAll(certificateId: string, patch: Partial<Certificate>) {
    const acceptance = useAcceptanceStore()
    for (const node of acceptance.equipment) {
      const cert = node.certificates.find((item) => item.id === certificateId)
      if (cert) Object.assign(cert, patch, { version: cert.version + 1 })
    }
    ensureServer()
    for (const node of server.value!.equipment) {
      const cert = node.certificates.find((item) => item.id === certificateId)
      if (cert) {
        Object.assign(cert, patch, { version: cert.version + 1 })
        const change = { value: patch.expiresAt ?? cert.expiresAt, confirmedAt: new Date().toISOString() }
        server.value!.fieldMeta[certKey(certificateId)] ??= {}
        server.value!.fieldMeta[certKey(certificateId)].expiresAt = { version: cert.version, confirmedAt: change.confirmedAt, crew: crew.value }
        server.value!.fieldMeta[certKey(certificateId)].verified = { version: cert.version, confirmedAt: change.confirmedAt, crew: crew.value }
      }
    }
    persistServer()
    acceptance.persist()
  }

  /** 签署：冲突/待回传未清不允许；签署成功后服务端冻结相关实体，本地回传记录一并冻结。 */
  async function signOff(): Promise<{ ok: boolean; message: string }> {
    if (hasConflicts.value) return { ok: false, message: '冲突未清，完整性检查与签署已停住' }
    if (hasPending.value) return { ok: false, message: '仍有待回传记录，需先完成回传并入' }
    if (!online.value) return { ok: false, message: '断网状态不能签署，需联网完成回传后再锁定' }
    if (serverFailures.value) return { ok: false, message: '回传通道故障，签署已停住，恢复后重试' }

    const acceptance = useAcceptanceStore()
    const result = acceptance.signOffLocally()
    if (!result.ok) return result

    const current = ensureServer()
    current.plantVersion = acceptance.plant.version
    current.signedAt = new Date().toISOString()
    for (const node of current.equipment) {
      node.status = '已验收'
      for (const item of node.items) current.entityLocks[itemKey(item.id)] = { version: item.version, plantVersion: current.plantVersion, signedAt: current.signedAt }
      for (const cert of node.certificates) current.entityLocks[certKey(cert.id)] = { version: cert.version, plantVersion: current.plantVersion, signedAt: current.signedAt }
    }
    for (const defect of current.defects) {
      current.entityLocks[defectKey(defect.id)] = { version: defect.version, plantVersion: current.plantVersion, signedAt: current.signedAt }
    }
    persistServer()

    const frozenAt = current.signedAt
    for (const record of records.value) {
      if (record.status === '已回传') {
        record.status = '已冻结'
        record.frozenAt = frozenAt
      }
    }
    acceptance.persist()
    persistSync()
    return { ok: true, message: '签署完成，回传记录已冻结' }
  }

  /** 载入演示场景：断网→两班组各自提交→联网后触发合并/冲突全流程。 */
  function loadDemoScenario() {
    const acceptance = useAcceptanceStore()
    const scenario = buildDemoScenario(new Date().toISOString())
    acceptance.loadScenario(scenario.equipment, scenario.defects)
    server.value = scenario.server
    records.value = scenario.outbox
    online.value = false
    serverFailures.value = false
    lastSyncAt.value = null
    syncNotice.value = '已载入双班组离线作业场景，恢复网络后开始合并待回传记录'
    persistServer()
    persistSync()
    refreshIdSeed()
  }

  function resetAll() {
    records.value = []
    const acceptance = useAcceptanceStore()
    server.value = createFreshServer(acceptance.equipment, acceptance.defects, acceptance.plant.version)
    online.value = true
    serverFailures.value = false
    lastSyncAt.value = null
    syncNotice.value = ''
    persistServer()
    persistSync()
  }

  function targetLabel(record: OutboxRecord) {
    const acceptance = useAcceptanceStore()
    const node = acceptance.equipment.find((item) => item.id === record.equipmentId)
    const nodeName = node ? `${node.name}（${node.code}）` : record.equipmentId
    let target = ''
    if (record.itemId) {
      const item: AcceptanceItem | undefined = node?.items.find((value) => value.id === record.itemId)
      target = item ? `${record.itemId} ${item.standard}` : record.itemId
    } else if (record.defectId) {
      const defect: AcceptanceDefect | undefined = acceptance.defects.find((value) => value.id === record.defectId)
      target = defect ? `${record.defectId} ${defect.title}` : record.defectId
    } else if (record.certificateId) {
      const cert: Certificate | undefined = node?.certificates.find((value) => value.id === record.certificateId)
      target = cert ? cert.name : record.certificateId!
    }
    return { nodeName, target }
  }

  return {
    online, crew, serverFailures, records, server, hydrated, lastSyncAt, syncNotice, frozen,
    pendingRecords, conflictRecords, mergedRecords, hasConflicts, hasPending, stats, conflictBlockers,
    hydrate, setCrew, setOnline, toggleServerFailures, enqueue, flushPending, retryRecord,
    resolveConflict, signOff, loadDemoScenario, resetAll, targetLabel, patchCertificateAll
  }
})
