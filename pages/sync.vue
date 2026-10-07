<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Tag from 'primevue/tag'
import Select from 'primevue/select'
import InputText from 'primevue/inputtext'
import { useToast } from 'primevue/usetoast'
import { useAcceptanceStore } from '../stores/acceptance'
import { useSyncStore, type ConflictResolution } from '../stores/sync'
import type { OutboxRecord } from '../types/domain'

const store = useAcceptanceStore()
const sync = useSyncStore()
const toast = useToast()

const crews = ['建设单位班组', '运维单位班组', '设备厂家班组']
const fieldNames: Record<string, string> = {
  status: '状态', measured: '实测结果', evidence: '证据', condition: '测试条件',
  name: '名称', issuer: '签发机构', expiresAt: '有效期', verified: '核验状态',
  decisionNote: '决定说明', owner: '责任方'
}
const fieldLabel = (field: string) => fieldNames[field] ?? field
const formatValue = (value: unknown) => typeof value === 'boolean' ? (value ? '已核验' : '待核验') : String(value ?? '')
const formatTime = (value?: string | null) => value ? value.replace('T', ' ').slice(0, 16) : '—'

const certRenew = reactive<Record<string, string>>({})

async function flush() {
  const result = await sync.flushPending('已执行回传合并')
  if (!result.ok) toast.add({ severity: 'warn', summary: '无法回传', detail: result.message, life: 3000 })
  else reportMerge()
}

function reportMerge() {
  const merged = sync.stats.merged
  toast.add({
    severity: sync.hasConflicts ? 'warn' : 'success',
    summary: '回传合并完成',
    detail: sync.hasConflicts ? `${sync.conflictRecords.length}条进入冲突区，完整性检查与签署已停住` : '待回传记录已全部并入',
    life: 3500
  })
  void merged
}

async function retry(record: OutboxRecord) {
  const result = await sync.retryRecord(record.id)
  if (!result.ok) toast.add({ severity: 'error', summary: '重试失败', detail: result.message, life: 3000 })
  else toast.add({ severity: record.status === '冲突' ? 'warn' : 'success', summary: record.status === '冲突' ? '仍有冲突' : '回传成功', detail: record.error ?? '已并入', life: 3000 })
}

async function resolve(record: OutboxRecord, action: ConflictResolution) {
  const result = await sync.resolveConflict(record.id, action, certRenew[record.id])
  toast.add({ severity: result.ok ? 'success' : 'error', summary: '冲突处理', detail: result.message, life: 3500 })
}

function loadScenario() {
  sync.loadDemoScenario()
  toast.add({ severity: 'info', summary: '演示场景已载入', detail: '当前断网：两班组已有待回传记录，恢复网络后自动合并', life: 4000 })
}

const resolutionOptions = (record: OutboxRecord): ConflictResolution[] => {
  if (record.conflict?.type === '证书失效') return ['证书续期', '放弃本班记录']
  if (record.conflict?.type === '签署版本不匹配') return ['重定基线', '采用服务端版本', '放弃本班记录']
  return ['按时间合并', '采用服务端版本', '放弃本班记录']
}

const statusSeverity = (status: string) =>
  status === '已回传' || status === '已冻结' ? 'success'
    : status === '冲突' ? 'danger'
      : status === '失败' ? 'warn' : 'secondary'

/** 冲突字段的服务端当前值，用于并列展示两个班组的确认结果。 */
function remoteFieldValue(record: OutboxRecord, field: string): unknown {
  const server = sync.server
  if (!server) return ''
  if (record.kind === '验收项更新') {
    return server.equipment.find((node) => node.id === record.equipmentId)
      ?.items.find((item) => item.id === record.itemId)?.[field as keyof typeof server.equipment[number]['items'][number]]
  }
  if (record.kind === '证书更新') {
    return server.equipment.find((node) => node.id === record.equipmentId)
      ?.certificates.find((cert) => cert.id === record.certificateId)?.[field as 'name' | 'expiresAt']
  }
  return server.defects.find((defect) => defect.id === record.defectId)?.[field as 'status' | 'decisionNote']
}
</script>

<template>
  <section class="page sync-page">
    <div class="section-head">
      <div><h2>回传与合并</h2><p>断网时验收项与处理说明离线暂存；网络恢复后按“同字段最后确认时间、不同字段分别保留”合并。冲突未清前，完整性检查与签署停住。</p></div>
      <Button label="载入双班组演示场景" severity="secondary" outlined @click="loadScenario" />
    </div>

    <div class="sync-controls">
      <label>当前班组
        <Select :modelValue="sync.crew" :options="crews" style="min-width:160px" @update:modelValue="sync.setCrew" />
      </label>
      <label class="switch-label">网络
        <button class="net-switch" :class="{ off: !sync.online }" @click="sync.setOnline(!sync.online)">
          <i :class="sync.online ? 'pi pi-wifi' : 'pi pi-wifi'"></i>{{ sync.online ? '在线' : '断网' }}
        </button>
      </label>
      <label class="switch-label">模拟回传通道故障
        <button class="net-switch fail" :class="{ off: !sync.serverFailures }" @click="sync.toggleServerFailures(!sync.serverFailures)">
          {{ sync.serverFailures ? '故障中' : '正常' }}
        </button>
      </label>
      <Button label="立即回传合并" icon="pi pi-refresh" :disabled="!sync.online || !sync.hasPending" @click="flush" />
      <span class="sync-hint">上次回传：{{ formatTime(sync.lastSyncAt) }} · {{ sync.online ? '在线时变更实时回传' : '断网变更进入待回传队列' }}</span>
    </div>

    <div v-if="sync.syncNotice" class="sync-notice">{{ sync.syncNotice }}</div>

    <div class="metrics">
      <article><span>待回传 / 失败</span><strong>{{ sync.stats.pending }}</strong><small>断网暂存，恢复后合并</small></article>
      <article :class="{ alarm: sync.hasConflicts }"><span>冲突区</span><strong>{{ sync.stats.conflicts }}</strong><small>未清前完整性检查与签署停住</small></article>
      <article><span>已回传并入</span><strong>{{ sync.stats.merged }}</strong><small>签署成功后冻结</small></article>
      <article><span>交付版本</span><strong>V{{ store.plant.version }}</strong><small>{{ store.plant.status }}</small></article>
    </div>

    <div v-if="sync.frozen" class="frozen-banner"><i class="pi pi-lock"></i>交付版本 V{{ store.plant.version }} 已签署锁定，全部回传记录已冻结，不再接受修改与回传。</div>

    <!-- 冲突区 -->
    <div class="sync-section conflict-zone">
      <div class="sync-section-head">
        <h3>冲突区 <Tag :value="`${sync.conflictRecords.length} 条`" severity="danger" /></h3>
        <p>被其他班组改过、证书失效或签署版本不匹配的记录在此处理；处理前记录保持原值，失败可重试。</p>
      </div>
      <p v-if="!sync.conflictRecords.length" class="empty-line">暂无冲突记录。</p>
      <article v-for="record in sync.conflictRecords" :key="record.id" class="conflict-card">
        <div class="conflict-main">
          <div class="conflict-title">
            <Tag :value="record.conflict?.type" severity="danger" />
            <strong>{{ sync.targetLabel(record).nodeName }}</strong>
            <span>{{ record.conflict?.targetLabel }}</span>
            <small>{{ record.crew }} · 依据 V{{ record.baseVersion }} → 服务端 V{{ record.conflict?.serverVersion }}</small>
          </div>
          <p class="conflict-message">{{ record.conflict?.message }}</p>
          <div v-if="record.conflict?.fields.length" class="field-diff">
            <div v-for="field in record.conflict.fields" :key="field" class="field-diff-row">
              <span class="field-name">{{ fieldLabel(field) }}</span>
              <span class="field-local"><i>本班 · {{ record.crew }}（{{ formatTime(record.changes[field]?.confirmedAt) }}）</i>{{ formatValue(record.changes[field]?.value) }}</span>
              <span class="field-remote"><i>{{ record.conflict.remoteCrew }}（{{ formatTime(record.conflict.remoteConfirmedAt) }}）</i>{{ formatValue(remoteFieldValue(record, field)) }}</span>
            </div>
          </div>
          <ul v-if="record.conflict?.certificates.length" class="cert-expire-list">
            <li v-for="cert in record.conflict.certificates" :key="cert.id">
              {{ cert.name }}，有效期至 {{ cert.expiresAt }}，并网日 {{ store.plant.commissioningDate }}
              <InputText v-if="resolutionOptions(record).includes('证书续期')" v-model="certRenew[record.id]" type="date" :min="store.plant.commissioningDate" style="margin-left:10px" />
            </li>
          </ul>
          <div class="conflict-actions">
            <Button v-for="action in resolutionOptions(record)" :key="action"
              :label="action"
              :severity="action === '放弃本班记录' ? 'danger' : action === '采用服务端版本' ? 'secondary' : 'primary'"
              :outlined="action !== '按时间合并' && action !== '证书续期' && action !== '重定基线'"
              size="small" @click="resolve(record, action)" />
          </div>
        </div>
      </article>
    </div>

    <!-- 待回传 -->
    <div class="sync-section">
      <div class="sync-section-head">
        <h3>待回传 / 失败 <Tag :value="`${sync.pendingRecords.length} 条`" :severity="sync.pendingRecords.length ? 'warn' : 'success'" /></h3>
        <p>失败后原记录保留在本队列，可在通道恢复后重试；签署前必须全部并入。</p>
      </div>
      <DataTable :value="sync.pendingRecords" dataKey="id" size="small">
        <Column field="id" header="记录号" style="width:110px" />
        <Column field="kind" header="类型" style="width:110px" />
        <Column header="班组"><template #body="{ data }">{{ data.crew }}</template></Column>
        <Column header="设备 / 对象">
          <template #body="{ data }">{{ sync.targetLabel(data).nodeName }} · {{ sync.targetLabel(data).target }}</template>
        </Column>
        <Column header="变更字段">
          <template #body="{ data }">
            <span v-if="data.kind === '处理说明'">处理说明：{{ data.reply?.content.slice(0, 24) }}…</span>
            <span v-else-if="data.kind === '联合复验'">第{{ data.retest?.round }}轮复验：{{ data.retest?.passed ? '通过' : '不通过' }}</span>
            <span v-else>{{ Object.keys(data.changes).map(fieldLabel).join('、') }}</span>
          </template>
        </Column>
        <Column header="最后确认"><template #body="{ data }">{{ formatTime(data.confirmedAt) }}</template></Column>
        <Column header="尝试"><template #body="{ data }">{{ data.attempts }} 次</template></Column>
        <Column header="状态">
          <template #body="{ data }">
            <Tag :value="data.status" :severity="statusSeverity(data.status)" />
            <small v-if="data.error" class="row-error">{{ data.error }}</small>
          </template>
        </Column>
        <Column header="">
          <template #body="{ data }">
            <Button label="重试回传" text size="small" :disabled="!sync.online" @click="retry(data)" />
          </template>
        </Column>
      </DataTable>
    </div>

    <!-- 已回传 / 冻结 -->
    <div class="sync-section">
      <div class="sync-section-head">
        <h3>已回传并入{{ sync.frozen ? '（已冻结）' : '' }}</h3>
        <p>签署成功后本区域记录与交付版本一并冻结。</p>
      </div>
      <DataTable :value="sync.mergedRecords" dataKey="id" size="small">
        <Column field="id" header="记录号" style="width:110px" />
        <Column field="kind" header="类型" style="width:110px" />
        <Column header="班组"><template #body="{ data }">{{ data.crew }}</template></Column>
        <Column header="设备 / 对象">
          <template #body="{ data }">{{ sync.targetLabel(data).nodeName }} · {{ sync.targetLabel(data).target }}</template>
        </Column>
        <Column header="回传时间"><template #body="{ data }">{{ formatTime(data.mergedAt) }}</template></Column>
        <Column header="处理说明">
          <template #body="{ data }"><small>{{ data.resolvedNote ?? '字段级合并并入' }}</small></template>
        </Column>
        <Column header="状态"><template #body="{ data }"><Tag :value="data.status" :severity="statusSeverity(data.status)" /></template></Column>
      </DataTable>
      <p v-if="!sync.mergedRecords.length" class="empty-line">尚无已回传记录。</p>
    </div>
  </section>
</template>
