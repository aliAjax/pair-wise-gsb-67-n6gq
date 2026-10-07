<script setup lang="ts">
import { computed, reactive } from 'vue'
import { useRoute } from 'vue-router'
import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import Tag from 'primevue/tag'
import Textarea from 'primevue/textarea'
import { useToast } from 'primevue/usetoast'
import { useAcceptanceStore } from '../../stores/acceptance'
import type { AcceptanceItem } from '../../types/domain'

const route = useRoute()
const store = useAcceptanceStore()
const toast = useToast()
const node = computed(() => store.equipment.find((item) => item.id === route.params.id))
const visible = ref(false)
const editable = reactive<Partial<AcceptanceItem>>({})
function syncState(itemId: string) {
  return store.pendingRecords.find((record) => record.itemId === itemId && ['待回传', '回传中', '回传失败', '冲突待处理'].includes(record.status))
}
function openItem(item: AcceptanceItem) { Object.assign(editable, structuredClone(item)); visible.value = true }
function save() {
  if (!node.value || !editable.id) return
  const result = store.updateItem(node.value.id, editable.id, editable)
  toast.add({ severity: result.ok ? 'success' : 'error', summary: result.message, life: 3500 })
  if (result.ok) visible.value = false
}
</script>

<template>
  <section v-if="node" class="page">
    <div class="section-head"><div><span>{{ node.id }} · {{ node.code }}</span><h2>{{ node.name }}</h2><p>{{ node.type }} · 当前状态 {{ node.status }} · 当前录入班组 {{ store.currentCrew }}</p></div><Tag :value="node.status" :severity="node.status === '已验收' ? 'success' : 'warn'" /></div>
    <div class="equipment-path"><span v-for="item in store.equipment.filter((value) => value.parentId === node?.parentId || value.id === node?.id)" :key="item.id" :class="{ active: item.id === node?.id }" @click="navigateTo(`/equipment/${item.id}`)">{{ item.name }}</span></div>
    <p v-if="store.frozen" class="frozen-note">交付版本已签署，验收项与回传记录均已冻结，不能再录入或复核。</p>
    <DataTable :value="node.items" dataKey="id" size="small">
      <Column field="id" header="编号" style="width:100px" />
      <Column field="standard" header="验收标准" />
      <Column field="method" header="测试方法" />
      <Column field="condition" header="测试条件" />
      <Column field="measured" header="实测结果" />
      <Column field="evidence" header="测试证据" />
      <Column header="状态"><template #body="{ data }"><Tag :value="data.status" :severity="data.status === '合格' ? 'success' : data.status === '不合格' ? 'danger' : 'warn'" /></template></Column>
      <Column header="版本"><template #body="{ data }">V{{ data.version }}</template></Column>
      <Column header="回传状态">
        <template #body="{ data }">
          <Tag v-if="syncState(data.id)?.status === '冲突待处理'" value="冲突待处理" severity="danger" />
          <Tag v-else-if="syncState(data.id)?.status === '回传失败'" value="回传失败可重试" severity="warn" />
          <Tag v-else-if="syncState(data.id)" :value="store.networkOnline ? '回传中' : '待回传(断网)'" severity="info" />
          <Tag v-else value="已与中心一致" severity="success" />
        </template>
      </Column>
      <Column header=""><template #body="{ data }"><Button label="录入/复核" text :disabled="store.frozen" @click="openItem(data)" /></template></Column>
    </DataTable>
    <div class="certificate-panel">
      <h3>证书与测试附件</h3>
      <div v-for="certificate in node.certificates" :key="certificate.id" class="certificate-item"><Tag :value="certificate.verified ? '已核验' : '待核验'" :severity="certificate.verified ? 'success' : 'danger'" /><strong>{{ certificate.name }}</strong><span>{{ certificate.issuer }}</span><span>有效期至 {{ certificate.expiresAt }}</span><small>V{{ certificate.version }}</small></div>
      <p v-if="!node.certificates.length">当前设备节点暂无证书附件。</p>
    </div>
    <Dialog v-model:visible="visible" header="录入验收项" modal :style="{ width: '620px' }">
      <div class="edit-grid">
        <label>状态<Select v-model="editable.status" :options="['待检查', '合格', '不合格', '待复验']" /></label>
        <label>实测结果<InputText v-model="editable.measured" /></label>
        <label>测试证据<InputText v-model="editable.evidence" /></label>
        <label>测试条件<Textarea v-model="editable.condition" rows="3" /></label>
      </div>
      <p class="dialog-hint">保存即视为本班确认：联网时立即回传；断网时进入待回传队列，恢复后与其他班组的提交按字段合并，同字段以最后确认时间为准。</p>
      <template #footer><Button label="取消" severity="secondary" text @click="visible = false" /><Button label="保存并确认回传" @click="save" /></template>
    </Dialog>
  </section>
  <section v-else class="page">未找到设备节点</section>
</template>
