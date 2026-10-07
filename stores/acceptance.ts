import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { seedAudit, seedDefects, seedEquipment, seedPlant } from '../data/seed'
import type { AcceptanceDefect, AcceptanceItem, AuditEntry, Certificate, EquipmentNode, PartyReply, Plant } from '../types/domain'

const STORAGE_KEY = 'gsb67:grid-acceptance'
let idSeed = 30

export const useAcceptanceStore = defineStore('acceptance', () => {
  const plant = ref<Plant>(structuredClone(seedPlant))
  const equipment = ref<EquipmentNode[]>(structuredClone(seedEquipment))
  const defects = ref<AcceptanceDefect[]>(structuredClone(seedDefects))
  const audit = ref<AuditEntry[]>(structuredClone(seedAudit))
  const selectedEquipmentId = ref(equipment.value[0].id)
  const keyword = ref('')
  const hydrated = ref(false)

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

  /** 完整性检查：冲突区未清、存在待回传/失败记录或断网时一并阻断，签署同样停住。 */
  const preflight = computed(() => {
    const blocking: string[] = []
    const sync = useSyncStoreLazy()
    if (sync) {
      blocking.push(...sync.conflictBlockers)
      if (sync.hasPending) blocking.push(`仍有${sync.stats.pending}条待回传/失败记录，网络恢复并入后才能继续`)
      if (!sync.online) blocking.push('当前断网，待回传记录尚未并入，完整性检查停住')
    }
    const items = equipment.value.flatMap((item) => item.items)
    if (items.some((item) => item.status === '待检查')) blocking.push('仍有验收项未检查')
    if (items.some((item) => item.status === '不合格' || item.status === '待复验')) blocking.push('存在不合格或待复验项')
    if (defects.value.some((item) => !['已关闭', '带条件通过'].includes(item.status))) blocking.push('存在未闭环缺陷')
    if (equipment.value.flatMap((item) => item.certificates).some((item) => !item.verified)) blocking.push('存在未核验证书')
    const expired = equipment.value.flatMap((item) => item.certificates).some((item) => item.expiresAt < plant.value.commissioningDate)
    if (expired) blocking.push('证书在并网日期前失效')
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
      }
    } catch {
      // Seed data is kept when browser storage is corrupt.
    }
    hydrated.value = true
    // 同步状态（服务端快照/待回传队列）随后水合，保证完整性检查可读取。
    const sync = useSyncStoreLazy()
    sync?.hydrate()
  }

  function persist() {
    if (!import.meta.client) return
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ plant: plant.value, equipment: equipment.value, defects: defectForPersist(), audit: audit.value }))
  }

  function defectForPersist() {
    // 复验轮次展示顺序与原实现保持一致（最新在前）。
    return defects.value
  }

  function updateItem(equipmentId: string, itemId: string, patch: Partial<AcceptanceItem>) {
    const node = equipment.value.find((value) => value.id === equipmentId)
    const item = node?.items.find((value) => value.id === itemId)
    if (!node || !item) return { ok: false, message: '验收项不存在' }
    const sync = useSyncStoreLazy()
    if (sync?.frozen) return { ok: false, message: '已签署锁定，记录冻结，不能修改' }

    const fields = ['status', 'measured', 'evidence', 'condition'] as const
    const changed = fields.filter((field) => patch[field] !== undefined && patch[field] !== item[field])
    if (!changed.length) return { ok: false, message: '没有检测到变更' }

    const now = new Date().toISOString()
    const changes = Object.fromEntries(changed.map((field) => [field, { value: patch[field], confirmedAt: now }]))
    // 先入队（冻结/断网判定），再做本地乐观更新；版本在回传并入后由服务端推进。
    const queued = sync!.enqueue({ kind: '验收项更新', equipmentId, itemId, baseVersion: item.version, changes })
    if (!queued.ok) return queued
    Object.assign(item, Object.fromEntries(changed.map((field) => [field, patch[field]])))
    log(equipmentId, '更新验收项', '当前用户', `${item.id}字段 ${changed.join('、')} 更新（${queued.message}）`)
    persist()
    return { ok: true, message: changed.some((field) => field === 'status') ? `状态已更新为${item.status}，${queued.message}` : queued.message }
  }

  function updateCertificate(equipmentId: string, certificateId: string, patch: Partial<Pick<Certificate, 'name' | 'expiresAt' | 'verified'>>) {
    const node = equipment.value.find((value) => value.id === equipmentId)
    const certificate = node?.certificates.find((value) => value.id === certificateId)
    if (!node || !certificate) return { ok: false, message: '证书不存在' }
    const sync = useSyncStoreLazy()
    if (sync?.frozen) return { ok: false, message: '已签署锁定，证书记录已冻结' }

    const fields = ['name', 'expiresAt', 'verified'] as const
    const changed = fields.filter((field) => patch[field] !== undefined && patch[field] !== certificate[field])
    if (!changed.length) return { ok: false, message: '没有检测到变更' }
    const now = new Date().toISOString()
    const changes = Object.fromEntries(changed.map((field) => [field, { value: patch[field], confirmedAt: now }]))
    const queued = sync!.enqueue({ kind: '证书更新', equipmentId, certificateId, baseVersion: certificate.version, changes })
    if (!queued.ok) return queued
    Object.assign(certificate, Object.fromEntries(changed.map((field) => [field, patch[field]])), { version: certificate.version + 1 })
    log(equipmentId, '更新证书', '当前用户', `${certificate.name}字段 ${changed.join('、')} 更新（${queued.message}）`)
    persist()
    return { ok: true, message: queued.message }
  }

  function assignDefect(id: string, owner: string) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    const sync = useSyncStoreLazy()
    if (sync?.frozen) return { ok: false, message: '已签署锁定，缺陷记录已冻结' }
    const now = new Date().toISOString()
    const changes = { owner: { value: owner, confirmedAt: now }, status: { value: '整改中', confirmedAt: now } }
    const queued = sync!.enqueue({ kind: '验收决定', equipmentId: defect.equipmentId, defectId: id, baseVersion: defect.version, changes })
    if (!queued.ok) return queued
    defect.owner = owner
    defect.status = '整改中'
    log(id, '分派缺陷', '验收负责人', `责任方调整为${owner}（${queued.message}）`)
    persist()
    return { ok: true, message: queued.message }
  }

  function addReply(id: string, reply: PartyReply) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect || !reply.content || !reply.evidence) return { ok: false, message: '回复内容和证据均不能为空' }
    const sync = useSyncStoreLazy()
    if (sync?.frozen) return { ok: false, message: '已签署锁定，处理说明记录已冻结' }
    const queued = sync!.enqueue({
      kind: '处理说明', equipmentId: defect.equipmentId, defectId: id, baseVersion: defect.version,
      changes: {}, reply
    })
    if (!queued.ok) return queued
    defect.replies.unshift(reply)
    if (!['已关闭', '带条件通过'].includes(defect.status)) defect.status = '待联合复验'
    log(id, `${reply.party}提交处理说明`, reply.owner, `${reply.content}（${queued.message}）`)
    persist()
    return { ok: true, message: `已提交处理说明，${queued.message}` }
  }

  function addRetest(id: string, result: string, passed: boolean) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    const sync = useSyncStoreLazy()
    if (sync?.frozen) return { ok: false, message: '已签署锁定，复验记录已冻结' }
    const round = defect.retests.length + 1
    const retest = { round, passed, result, tester: '联合验收组', testedAt: new Date().toISOString() }
    const queued = sync!.enqueue({
      kind: '联合复验', equipmentId: defect.equipmentId, defectId: id, baseVersion: defect.version,
      changes: { status: { value: passed ? '已关闭' : '整改中', confirmedAt: retest.testedAt } }, retest
    })
    if (!queued.ok) return queued
    defect.retests.unshift(retest)
    defect.status = passed ? '已关闭' : '整改中'
    log(id, '执行联合复验', '联合验收组', `${result}（${queued.message}）`)
    persist()
    return { ok: true, message: queued.message }
  }

  function decideDefect(id: string, status: '已关闭' | '带条件通过' | '整改中', note: string) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    if (status === '已关闭' && !defect.retests.some((item) => item.passed)) return { ok: false, message: '没有合格复验记录，不能关闭' }
    if (status === '带条件通过' && !note.trim()) return { ok: false, message: '带条件通过必须说明限制条件' }
    const sync = useSyncStoreLazy()
    if (sync?.frozen) return { ok: false, message: '已签署锁定，验收决定记录已冻结' }
    const now = new Date().toISOString()
    const changes = { status: { value: status, confirmedAt: now }, decisionNote: { value: note, confirmedAt: now } }
    const queued = sync!.enqueue({ kind: '验收决定', equipmentId: defect.equipmentId, defectId: id, baseVersion: defect.version, changes })
    if (!queued.ok) return queued
    defect.status = status
    defect.decisionNote = note
    log(id, `验收决定：${status}`, '验收负责人', `${note || '完成整改闭环'}（${queued.message}）`)
    persist()
    return { ok: true, message: `缺陷已更新为${status}，${queued.message}` }
  }

  /** 仅执行本地签署锁定；服务端冻结与回传记录冻结由 sync store 负责。 */
  function signOffLocally() {
    if (!preflight.value.allowed) return { ok: false as const, message: preflight.value.blocking.join('；') }
    plant.value.status = '已签署'
    plant.value.version += 1
    equipment.value.forEach((node) => { node.status = '已验收' })
    log(plant.value.id, '签署交付版本', '验收负责人陆川', `锁定V${plant.value.version}并生成交付包`)
    persist()
    return { ok: true as const, message: '签署完成，交付版本已锁定' }
  }

  function reset() {
    plant.value = structuredClone(seedPlant)
    equipment.value = structuredClone(seedEquipment)
    defects.value = structuredClone(seedDefects)
    audit.value = structuredClone(seedAudit)
    persist()
    useSyncStoreLazy()?.resetAll()
  }

  /** 载入双班组演示场景的本地数据。 */
  function loadScenario(nextEquipment: EquipmentNode[], nextDefects: AcceptanceDefect[]) {
    plant.value = structuredClone(seedPlant)
    equipment.value = structuredClone(nextEquipment)
    defects.value = structuredClone(nextDefects)
    audit.value = structuredClone(seedAudit)
    persist()
  }

  function log(entityId: string, action: string, operator: string, detail: string) {
    audit.value.unshift({ id: `AUD-${Date.now()}-${idSeed++}`, entityId, action, operator, detail, createdAt: new Date().toISOString() })
  }

  return {
    plant, equipment, defects, audit, selectedEquipmentId, keyword, hydrated,
    selectedEquipment, stats, preflight, hydrate, persist,
    updateItem, updateCertificate, assignDefect, addReply, addRetest, decideDefect,
    signOffLocally, reset, loadScenario, log
  }
})

// 延迟获取 sync store：两 store 互相引用，Pinia 仅在动作执行期间解析。
import { useSyncStore } from './sync'
function useSyncStoreLazy() {
  if (!import.meta.client) return null
  return useSyncStore()
}
