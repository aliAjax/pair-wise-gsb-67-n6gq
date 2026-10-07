<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
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
import { useSyncStore } from '../../stores/sync'
import type { AcceptanceItem, Certificate } from '../../types/domain'

const route = useRoute()
const store = useAcceptanceStore()
const sync = useSyncStore()
const toast = useToast()
const node = computed(() => store.equipment.find((item) => item.id === route.params.id))
const commissioningDate = computed(() => store.plant.commissioningDate)
const siblingNodes = computed(() =>
  node.value ? store.equipment.filter((value) => value.parentId === node.value!.parentId || value.id === node.value!.id) : [])
const visible = ref(false)
const editable = reactive<Partial<AcceptanceItem>>({})
const certVisible = ref(false)
const certEditable = reactive<Partial<Certificate>>({})
function openItem(item: AcceptanceItem) { Object.assign(editable, structuredClone(item)); visible.value = true }
function openCertificate(certificate: Certificate) { Object.assign(certEditable, structuredClone(certificate)); certVisible.value = true }
function save() {
  if (!node.value || !editable.id) return
  const result = store.updateItem(node.value.id, editable.id, editable)
  toast.add({ severity: result.ok ? 'success' : 'error', summary: result.ok ? '已保存' : '未保存', detail: result.message, life: 3200 })
  if (result.ok) visible.value = false
}
function saveCertificate() {
  if (!node.value || !certEditable.id) return
  const result = store.updateCertificate(node.value.id, certEditable.id, {
    name: certEditable.name, expiresAt: certEditable.expiresAt, verified: certEditable.verified
  })
  toast.add({ severity: result.ok ? 'success' : 'error', summary: result.ok ? '证书已更新' : '未保存', detail: result.message, life: 3200 })
  if (result.ok) certVisible.value = false
}
</script>

<template>
  <section v-if="node" class="page">
    <div class="section-head"><div><span>{{ node.id }} · {{ node.code }}</span><h2>{{ node.name }}</h2><p>{{ node.type }} · 当前状态 {{ node.status }} · {{ sync.online ? '变更实时回传' : '断网暂存，恢复后回传合并' }}</p></div><Tag :value="node.status" :severity="node.status === '已验收' ? 'success' : 'warn'" /></div>
    <div class="equipment-path"><span v-for="item in siblingNodes" :key="item.id" :class="{ active: item.id === node.id }" @click="navigateTo(`/equipment/${item.id}`)">{{ item.name }}</span></div>
    <DataTable :value="node.items" dataKey="id" size="small">
      <Column field="id" header="编号" style="width:100px" />
      <Column field="standard" header="验收标准" />
      <Column field="method" header="测试方法" />
      <Column field="condition" header="测试条件" />
      <Column field="measured" header="实测结果" />
      <Column field="evidence" header="测试证据" />
      <Column header="状态"><template #body="{ data }"><Tag :value="data.status" :severity="data.status === '合格' ? 'success' : data.status === '不合格' ? 'danger' : 'warn'" /></template></Column>
      <Column header="版本"><template #body="{ data }">V{{ data.version }}</template></Column>
      <Column header=""><template #body="{ data }"><Button label="录入/复核" text @click="openItem(data)" /></template></Column>
    </DataTable>
    <div class="certificate-panel">
      <h3>证书与测试附件</h3>
      <div v-for="certificate in node.certificates" :key="certificate.id" class="certificate-item">
        <Tag :value="certificate.verified ? '已核验' : '待核验'" :severity="certificate.verified ? 'success' : 'danger'" />
        <strong>{{ certificate.name }}</strong><span>{{ certificate.issuer }}</span>
        <span :class="{ 'cert-expired': certificate.expiresAt < commissioningDate }">有效期至 {{ certificate.expiresAt }}<i v-if="certificate.expiresAt < commissioningDate">（已在并网日前失效，回传将进入冲突区）</i></span>
        <small>V{{ certificate.version }}</small>
        <Button label="续期/核验" text size="small" @click="openCertificate(certificate)" />
      </div>
      <p v-if="!node.certificates.length">当前设备节点暂无证书附件。</p>
    </div>
    <Dialog v-model:visible="visible" header="录入验收项" modal :style="{ width: '620px' }">
      <div class="edit-grid">
        <label>状态<Select v-model="editable.status" :options="['待检查', '合格', '不合格', '待复验']" /></label>
        <label>实测结果<InputText v-model="editable.measured" /></label>
        <label>测试证据<InputText v-model="editable.evidence" /></label>
        <label>测试条件<Textarea v-model="editable.condition" rows="3" /></label>
      </div>
      <template #footer><Button label="取消" severity="secondary" text @click="visible = false" /><Button label="保存并回传" @click="save" /></template>
    </Dialog>
    <Dialog v-model:visible="certVisible" header="证书续期 / 核验" modal :style="{ width: '520px' }">
      <div class="edit-grid">
        <label class="wide">证书名称<InputText v-model="certEditable.name" /></label>
        <label>有效期至<InputText v-model="certEditable.expiresAt" type="date" /></label>
        <label>核验状态<Select v-model="certEditable.verified" :options="[{ label: '已核验', value: true }, { label: '待核验', value: false }]" /></label>
      </div>
      <template #footer><Button label="取消" severity="secondary" text @click="certVisible = false" /><Button label="保存并回传" @click="saveCertificate" /></template>
    </Dialog>
  </section>
  <section v-else class="page">未找到设备节点</section>
</template>
