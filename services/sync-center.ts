import type { AcceptanceDefect, Crew, EquipmentNode, FieldChange, PartyReply, Plant } from '../types/domain'

// 纯前端工程：用 localStorage 中独立的命名空间模拟“中心服务端”快照，
// 其他班组的修改、证书失效和签署版本推进都落在这份中心快照上。
const CENTER_KEY = 'gsb67:center-snapshot'

export interface CenterSnapshot {
  plant: Plant
  equipment: EquipmentNode[]
  defects: AcceptanceDefect[]
  fieldMeta: Record<string, { value: string; confirmedAt: string; crew: Crew | null }>
  updatedAt: string
}

export const ITEM_FIELDS = [
  { field: 'status', label: '检查状态' },
  { field: 'measured', label: '实测结果' },
  { field: 'evidence', label: '测试证据' },
  { field: 'condition', label: '测试条件' }
] as const

function fieldKey(equipmentId: string, itemId: string, field: string) {
  return `item:${equipmentId}:${itemId}:${field}`
}

function readSnapshot(): CenterSnapshot | null {
  if (!import.meta.client) return null
  try {
    const raw = localStorage.getItem(CENTER_KEY)
    return raw ? JSON.parse(raw) as CenterSnapshot : null
  } catch {
    return null
  }
}

function writeSnapshot(snapshot: CenterSnapshot) {
  if (!import.meta.client) return
  localStorage.setItem(CENTER_KEY, JSON.stringify(snapshot))
}

export function getCenterSnapshot(seed: { plant: Plant; equipment: EquipmentNode[]; defects: AcceptanceDefect[] }): CenterSnapshot {
  const existing = readSnapshot()
  if (existing) return existing
  const snapshot: CenterSnapshot = {
    plant: structuredClone(seed.plant),
    equipment: structuredClone(seed.equipment),
    defects: structuredClone(seed.defects),
    fieldMeta: {},
    updatedAt: new Date().toISOString()
  }
  writeSnapshot(snapshot)
  return snapshot
}

export function resetCenterSnapshot(seed: { plant: Plant; equipment: EquipmentNode[]; defects: AcceptanceDefect[] }): CenterSnapshot {
  const snapshot: CenterSnapshot = {
    plant: structuredClone(seed.plant),
    equipment: structuredClone(seed.equipment),
    defects: structuredClone(seed.defects),
    fieldMeta: {},
    updatedAt: new Date().toISOString()
  }
  writeSnapshot(snapshot)
  return snapshot
}

// 模拟网络链路：离线直接失败；也可通过 failNextCount 制造联网时的回传失败。
let online = true
let failNextCount = 0

export function isOnline() { return online }
export function setOnline(value: boolean) { online = value }
export function scheduleFailures(count: number) { failNextCount = Math.max(0, count) }

export function networkCall<T>(executor: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (!online) {
        reject(new Error('网络不可用，记录保留在待回传队列'))
        return
      }
      if (failNextCount > 0) {
        failNextCount -= 1
        reject(new Error('中心网关超时，回传未完成，可重试'))
        return
      }
      resolve(executor())
    }, 280)
  })
}

// 其他班组在中心端改动了某个验收项字段，用于演示字段级合并与冲突。
export function simulateOtherCrewItemChange(equipmentId: string, itemId: string, field: string, value: string, crew: Crew) {
  const snapshot = readSnapshot()
  if (!snapshot) return
  const item = snapshot.equipment.find((node) => node.id === equipmentId)?.items.find((value2) => value2.id === itemId)
  if (!item) return
  ;(item as unknown as Record<string, unknown>)[field] = value
  item.version += 1
  const confirmedAt = new Date().toISOString()
  snapshot.fieldMeta[fieldKey(equipmentId, itemId, field)] = { value, confirmedAt, crew }
  snapshot.updatedAt = confirmedAt
  writeSnapshot(snapshot)
}

// 中心端证书被标记失效（核验撤销或有效期被改到并网日期之前）。
export function simulateCertificateInvalid(equipmentId: string, certificateId: string, expiresAt: string, verified: boolean) {
  const snapshot = readSnapshot()
  if (!snapshot) return
  const certificate = snapshot.equipment.find((node) => node.id === equipmentId)?.certificates.find((item) => item.id === certificateId)
  if (!certificate) return
  certificate.expiresAt = expiresAt
  certificate.verified = verified
  certificate.version += 1
  snapshot.updatedAt = new Date().toISOString()
  writeSnapshot(snapshot)
}

// 中心端完成新一轮签署，本地仍停留在旧版本即构成签署版本不匹配。
export function simulateCentralSign(plantVersion: number) {
  const snapshot = readSnapshot()
  if (!snapshot) return
  snapshot.plant.status = '已签署'
  snapshot.plant.version = plantVersion
  snapshot.updatedAt = new Date().toISOString()
  writeSnapshot(snapshot)
}

export function getFieldMeta(snapshot: CenterSnapshot, equipmentId: string, itemId: string, field: string) {
  return snapshot.fieldMeta[fieldKey(equipmentId, itemId, field)]
}

export function writeFieldMeta(snapshot: CenterSnapshot, equipmentId: string, itemId: string, field: string, value: string, confirmedAt: string, crew: Crew) {
  snapshot.fieldMeta[fieldKey(equipmentId, itemId, field)] = { value, confirmedAt, crew }
}

export function saveSnapshot(snapshot: CenterSnapshot) {
  snapshot.updatedAt = new Date().toISOString()
  writeSnapshot(snapshot)
}

export function mergeReplyUnion(local: PartyReply[], central: PartyReply[]): PartyReply[] {
  const merged: PartyReply[] = []
  const seen = new Set<string>()
  for (const reply of [...local, ...central]) {
    const key = `${reply.party}|${reply.owner}|${reply.content}|${reply.repliedAt}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(reply)
  }
  return merged.sort((a, b) => b.repliedAt.localeCompare(a.repliedAt))
}

export function buildFieldChanges(equipmentId: string, itemId: string, base: Record<string, string>, next: Record<string, string>, confirmedAt: string): FieldChange[] {
  return ITEM_FIELDS
    .map(({ field, label }) => ({ field, label }))
    .filter(({ field }) => base[field] !== next[field])
    .map(({ field, label }) => ({
      field,
      fieldLabel: label,
      baseValue: base[field] ?? '',
      localValue: next[field] ?? '',
      localConfirmedAt: confirmedAt
    }))
}
