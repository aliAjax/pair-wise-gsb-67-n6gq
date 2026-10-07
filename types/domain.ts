export type InspectionStatus = '待检查' | '合格' | '不合格' | '待复验'
export type DefectStatus = '待分派' | '整改中' | '待联合复验' | '已关闭' | '带条件通过'
export type Party = '建设单位' | '设备厂家' | '运维单位'

export interface AcceptanceItem {
  id: string
  standard: string
  method: string
  condition: string
  status: InspectionStatus
  measured: string
  evidence: string
  version: number
}

export interface Certificate {
  id: string
  name: string
  issuer: string
  expiresAt: string
  version: number
  verified: boolean
}

export interface EquipmentNode {
  id: string
  parentId: string | null
  name: string
  type: '并网点' | '变压器' | '方阵' | '逆变器' | '汇流箱'
  code: string
  status: '待验收' | '验收中' | '已验收'
  items: AcceptanceItem[]
  certificates: Certificate[]
}

export interface PartyReply {
  party: Party
  owner: string
  content: string
  evidence: string
  repliedAt: string
}

export interface AcceptanceDefect {
  id: string
  equipmentId: string
  itemId: string
  title: string
  severity: '一般' | '重大'
  status: DefectStatus
  owner: string
  dueDate: string
  replies: PartyReply[]
  retests: Array<{ round: number; passed: boolean; result: string; tester: string; testedAt: string }>
  decisionNote: string
  version: number
}

export interface Plant {
  id: string
  name: string
  gridPoint: string
  capacity: string
  commissioningDate: string
  status: '验收中' | '待复核' | '已签署'
  version: number
}

export interface AuditEntry {
  id: string
  entityId: string
  action: string
  operator: string
  detail: string
  createdAt: string
}

export type Crew = '建设班组' | '电气班组' | '运维班组'
export type PendingEntityType = '验收项' | '缺陷处理说明'
export type PendingRecordStatus = '待回传' | '回传中' | '回传失败' | '已回传' | '冲突待处理' | '已冻结'
export type ConflictReason = '被其他班组改过' | '证书失效' | '签署版本不匹配'

export interface FieldChange {
  field: string
  fieldLabel: string
  baseValue: string
  localValue: string
  centralValue?: string
  localConfirmedAt: string
  centralConfirmedAt?: string
  centralCrew?: Crew | null
}

export interface PendingSyncRecord {
  id: string
  entityType: PendingEntityType
  equipmentId: string
  equipmentName: string
  entityId: string
  itemId?: string
  entityLabel: string
  crew: Crew
  fields: FieldChange[]
  replies: PartyReply[]
  baseVersion: number
  basePlantVersion: number
  status: PendingRecordStatus
  conflictReason?: ConflictReason
  conflictDetail?: string
  resolutionNote?: string
  lastError: string
  attempts: number
  createdAt: string
  confirmedAt: string
  syncedAt?: string
  frozenAt?: string
}
