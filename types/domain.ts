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

export type ChangeKind = '验收项更新' | '证书更新' | '处理说明' | '联合复验' | '验收决定'
export type SyncRecordStatus = '待回传' | '回传中' | '已回传' | '冲突' | '失败' | '已放弃' | '已冻结'
export type ConflictType = '被其他班组改过' | '证书失效' | '签署版本不匹配'

export interface FieldChange {
  value: unknown
  confirmedAt: string
}

export interface SyncCertificateRef {
  id: string
  name: string
  expiresAt: string
  verified: boolean
}

export interface SyncConflict {
  type: ConflictType
  equipmentId: string
  equipmentName: string
  equipmentCode: string
  targetRef: string
  targetLabel: string
  fields: string[]
  certificates: SyncCertificateRef[]
  baseVersion: number
  serverVersion: number
  signedVersion?: number
  localValue?: string
  serverValue?: string
  remoteCrew?: string
  remoteConfirmedAt?: string
  message: string
}

export interface OutboxRecord {
  id: string
  kind: ChangeKind
  crew: string
  equipmentId: string
  itemId?: string
  defectId?: string
  certificateId?: string
  changes: Record<string, FieldChange>
  reply?: PartyReply
  retest?: { round: number; passed: boolean; result: string; tester: string; testedAt: string }
  baseVersion: number
  basePlantVersion: number
  status: SyncRecordStatus
  attempts: number
  error?: string
  conflict?: SyncConflict
  resolvedNote?: string
  createdAt: string
  confirmedAt: string
  mergedAt?: string
  frozenAt?: string
}

export interface ChangeDescriptor {
  kind: ChangeKind
  equipmentId: string
  itemId?: string
  defectId?: string
  certificateId?: string
  changes: Record<string, FieldChange>
  reply?: PartyReply
  retest?: OutboxRecord['retest']
  baseVersion: number
}
