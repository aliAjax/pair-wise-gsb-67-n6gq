<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import Tag from 'primevue/tag'
import { useToast } from 'primevue/usetoast'
import { useAcceptanceStore, CREW_OPTIONS } from '../stores/acceptance'
import { ITEM_FIELDS } from '../services/sync-center'
import type { Crew, PendingSyncRecord } from '../types/domain'

const store = useAcceptanceStore()
const toast = useToast()

const pendingRows = computed(() => store.pendingRecords.filter((item) => ['待回传', '回传中', '回传失败'].includes(item.status)))
const frozenRows = computed(() => store.pendingRecords.filter((item) => item.status === '已回传' || item.status === '已冻结'))

const sim = reactive({
  crew: '建设班组' as Crew,
  equipmentId: 'EQ-INV11',
  itemId: 'IT-I2',
  field: 'measured',
  value: '98.7%'
})
const simBusy = ref(false)

const fieldOptions = ITEM_FIELDS.map((item) => ({ label: item.label, value: item.field }))
const targetItems = computed(() => {
  const node = store.equipment.find((item) => item.id === sim.equipmentId)
  return node?.items.map((item) => ({ label: `${item.id} ${item.standard.slice(0, 12)}`, value: item.id })) ?? []
})

function statusTag(status: PendingSyncRecord['status']) {
  switch (status) {
    case '待回传': return { severity: 'warn' as const }
    case '回传中': return { severity: 'info' as const }
    case '回传失败': return { severity: 'danger' as const }
    case '冲突待处理': return { severity: 'danger' as const }
    case '已回传': return { severity: 'success' as const }
    case '已冻结': return { severity: 'secondary' as const }
  }
}

function time(value?: string) { return value ? value.replace('T', ' ').slice(0, 16) : '—' }

async function syncAll() {
  const result = await store.syncAllPending()
  if (result.merged) toast.add({ severity: 'success', summary: `已合并 ${result.merged} 条记录`, life: 3000 })
  if (result.conflict) toast.add({ severity: 'warn', summary: `${result.conflict} 条进入冲突区`, detail: '完整性检查与签署已暂停，请先处理冲突', life: 4500 })
  if (result.failed) toast.add({ severity: 'error', summary: `${result.failed} 条回传失败`, detail: '原记录已保留，可重试', life: 4000 })
}

async function retry(record: PendingSyncRecord) {
  const result = await store.retryRecord(record.id)
  toast.add({ severity: result.ok ? 'success' : (record.status === '冲突待处理' ? 'warn' : 'error'), summary: result.message, life: 3500 })
}

async function resolve(record: PendingSyncRecord, action: 'adopt-central' | 'keep-local') {
  const result = await store.resolveConflict(record.id, action)
  toast.add({ severity: result.ok ? 'success' : 'error', summary: result.message, life: 3800 })
}

async function simulateSameField() {
  simBusy.value = true
  store.simulateOtherCrew(sim.equipmentId, sim.itemId, sim.field, sim.value, sim.crew)
  toast.add({ severity: 'info', summary: `已模拟${sim.crew}在中心端修改同一字段`, detail: '对该验收项的待回传记录执行重试即可看到冲突', life: 4000 })
  simBusy.value = false
}

function simulateDifferentField() {
  // 自动挑一条本班待回传记录里没有修改的字段，让其他班组在中心修改，演示不同字段分别保留
  const target = pendingRows.value.find((item) => item.entityType === '验收项')
  if (!target) {
    toast.add({ severity: 'warn', summary: '请先在断网时录入一条验收项', detail: '不同字段合并需要一条待回传记录', life: 4000 })
    return
  }
  const freeField = ITEM_FIELDS.find((field) => !target.fields.some((item) => item.field === field.field))
  if (!freeField) {
    toast.add({ severity: 'warn', summary: '该记录已修改全部字段', life: 3000 })
    return
  }
  const value = freeField.field === 'status' ? '合格' : `${freeField.label}由${sim.crew}补充_${new Date().toISOString().slice(11, 16)}`
  store.simulateOtherCrew(target.equipmentId, target.entityId, freeField.field, value, sim.crew)
  toast.add({ severity: 'info', summary: `已模拟${sim.crew}在中心修改「${freeField.label}」(不同字段)`, detail: '重试回传后两边字段都会保留', life: 4500 })
}

function simulateCertificate() {
  // 找到当前目标设备的第一张证书：置为核验撤销且有效期早于并网日期
  const node = store.equipment.find((item) => item.id === sim.equipmentId)
  const certificate = node?.certificates[0]
  if (!node || !certificate) {
    toast.add({ severity: 'warn', summary: '该设备没有证书，请选择并网点/变压器/逆变器', life: 3500 })
    return
  }
  store.simulateCertificate(node.id, certificate.id, '2026-09-15', false)
  toast.add({ severity: 'info', summary: '已模拟中心端证书失效', detail: `${certificate.name} 核验撤销且有效期早于并网日期`, life: 4500 })
}

function simulateSign() {
  store.simulateCentralSign(store.plant.version + 1)
  toast.add({ severity: 'info', summary: `已模拟中心签署 V${store.plant.version + 1}`, detail: '待回传记录基于旧版本，重试将报签署版本不匹配', life: 4500 })
}

function resetCenter() {
  store.reset()
  toast.add({ severity: 'success', summary: '已恢复演示数据并重置中心快照', life: 3000 })
}
</script>

<template>
  <section class="page">
    <div class="sync-band">
      <article>
        <span>当前班组</span>
        <Select :model-value="store.currentCrew" :options="CREW_OPTIONS" @update:model-value="store.setCrew" />
        <small>两个班组同时提交时按班组区分来源</small>
      </article>
      <article>
        <span>网络状态</span>
        <div class="net-state">
          <Tag :value="store.networkOnline ? '联网中' : '断网'" :severity="store.networkOnline ? 'success' : 'danger'" />
          <Button :label="store.networkOnline ? '模拟断网' : '网络恢复，合并回传'" :severity="store.networkOnline ? 'danger' : 'success'" outlined size="small" @click="store.toggleNetwork(!store.networkOnline)" />
        </div>
        <small>断网录入不会要求重抄，恢复联网后按确认时间字段级合并</small>
      </article>
      <article>
        <span>回传队列</span>
        <strong>{{ store.pendingCount }} 条待回传 · {{ store.failedCount }} 条失败</strong>
        <div class="net-state">
          <Button label="立即合并回传" size="small" :disabled="!store.networkOnline || store.pendingCount === 0 || store.frozen" @click="syncAll" />
          <Button label="模拟下一次网关失败" size="small" severity="secondary" outlined @click="store.simulateNextFailure" />
        </div>
      </article>
    </div>

    <div v-if="store.frozen" class="freeze-banner">交付版本已于 V{{ store.plant.version }} 签署锁定，全部回传记录已冻结，不再接受录入、回传或重试。</div>

    <div class="section-head"><div><h2>冲突区</h2><p>被其他班组改过（同字段对方后确认）、证书失效或签署版本不匹配的记录在此停留；未清空冲突前，完整性检查和签署都会停住。</p></div><Tag :value="`${store.conflictCount} 条冲突`" :severity="store.conflictCount ? 'danger' : 'success'" /></div>
    <DataTable :value="store.conflictRecords" dataKey="id" size="small" class="conflict-table">
      <Column header="设备 / 验收项"><template #body="{ data }"><strong>{{ data.equipmentName }}</strong><small>{{ data.equipmentId }} · {{ data.entityType }}「{{ data.entityLabel }}」</small></template></Column>
      <Column header="提交班组"><template #body="{ data }">{{ data.crew }}</template></Column>
      <Column header="冲突原因"><template #body="{ data }"><Tag :value="data.conflictReason" severity="danger" /></template></Column>
      <Column header="具体说明"><template #body="{ data }"><p class="conflict-detail">{{ data.conflictDetail }}</p></template></Column>
      <Column header="操作">
        <template #body="{ data }">
          <div class="row-actions">
            <Button label="保留本班并重试" size="small" @click="resolve(data, 'keep-local')" />
            <Button label="采用中心版本" size="small" severity="secondary" outlined @click="resolve(data, 'adopt-central')" />
          </div>
        </template>
      </Column>
    </DataTable>

    <div class="section-head" style="margin-top: 22px"><div><h2>待回传记录</h2><p>同一设备同一验收项的多次录入会合并为一条；同字段按最后确认时间处理，不同字段分别保留；回传失败保留原记录并可重试。</p></div></div>
    <DataTable :value="pendingRows" dataKey="id" size="small">
      <Column header="设备 / 对象"><template #body="{ data }"><strong>{{ data.equipmentName }}</strong><small>{{ data.equipmentId }} · {{ data.entityType }}「{{ data.entityLabel }}」</small></template></Column>
      <Column header="变更字段 / 说明">
        <template #body="{ data }">
          <p v-if="data.fields.length" class="field-change"><span v-for="field in data.fields" :key="field.field">{{ field.fieldLabel }}：{{ field.baseValue || '空' }} → <b>{{ field.localValue || '空' }}</b><em v-if="field.centralCrew" class="central-hint">（中心：{{ field.centralCrew }} {{ field.centralValue }}）</em>；</span></p>
          <p v-else class="field-change">{{ data.replies.map((reply: any) => `${reply.party}处理说明×1`).join('；') }}</p>
        </template>
      </Column>
      <Column field="crew" header="班组" />
      <Column header="确认时间"><template #body="{ data }">{{ time(data.confirmedAt) }}</template></Column>
      <Column header="尝试次数"><template #body="{ data }">{{ data.attempts }}</template></Column>
      <Column header="状态/错误"><template #body="{ data }"><Tag :value="data.status" v-bind="statusTag(data.status)" /><small v-if="data.lastError" class="error-text">{{ data.lastError }}</small></template></Column>
      <Column header=""><template #body="{ data }"><Button label="重试回传" size="small" :loading="store.syncingIds.has(data.id)" :disabled="!store.networkOnline" @click="retry(data)" /></template></Column>
    </DataTable>

    <div class="section-head" style="margin-top: 22px"><div><h2>已回传 / 已冻结记录</h2><p>签署成功后回传记录冻结，冻结记录保留变更内容与最终处置说明。</p></div></div>
    <DataTable :value="frozenRows" dataKey="id" size="small">
      <Column header="设备 / 对象"><template #body="{ data }"><strong>{{ data.equipmentName }}</strong><small>{{ data.equipmentId }} · {{ data.entityType }}「{{ data.entityLabel }}」</small></template></Column>
      <Column field="crew" header="班组" />
      <Column header="回传时间"><template #body="{ data }">{{ time(data.syncedAt) }}</template></Column>
      <Column header="状态"><template #body="{ data }"><Tag :value="data.status" v-bind="statusTag(data.status)" /></template></Column>
      <Column header="处置说明"><template #body="{ data }"><small>{{ data.resolutionNote || '字段级合并完成' }}</small></template></Column>
    </DataTable>

    <div class="sim-panel">
      <div class="section-head"><div><h2>中心端场景模拟</h2><p>纯前端演示：在“中心快照”上模拟其他班组操作，随后对上方待回传记录执行重试。</p></div><Button label="恢复全部演示数据" severity="secondary" outlined size="small" @click="resetCenter" /></div>
      <div class="sim-grid">
        <label>其他班组<Select v-model="sim.crew" :options="CREW_OPTIONS" /></label>
        <label>设备<Select v-model="sim.equipmentId" :options="store.equipment.map((item) => ({ label: `${item.name}`, value: item.id }))" /></label>
        <label>验收项<Select v-model="sim.itemId" :options="targetItems" /></label>
        <label>字段<Select v-model="sim.field" :options="fieldOptions" /></label>
        <label>中心端新值<InputText v-model="sim.value" /></label>
        <div class="sim-actions">
          <Button label="模拟其他班组改同字段（后确认→冲突）" :loading="simBusy" @click="simulateSameField" />
          <Button label="模拟其他班组改不同字段（自动合并保留）" severity="secondary" outlined @click="simulateDifferentField" />
          <Button label="模拟证书失效" severity="danger" outlined @click="simulateCertificate" />
          <Button label="模拟中心完成新一轮签署" severity="danger" outlined @click="simulateSign" />
        </div>
      </div>
    </div>
  </section>
</template>
