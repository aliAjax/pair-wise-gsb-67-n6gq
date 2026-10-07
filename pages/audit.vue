<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import InputText from 'primevue/inputtext'
import Tag from 'primevue/tag'
import { useToast } from 'primevue/usetoast'
import { useAcceptanceStore } from '../stores/acceptance'
import { useSyncStore } from '../stores/sync'

const store = useAcceptanceStore()
const sync = useSyncStore()
const toast = useToast()
const keyword = ref('')
const rows = computed(() => store.audit.filter((item) => !keyword.value || `${item.entityId} ${item.action} ${item.operator} ${item.detail}`.includes(keyword.value)))

async function sign() {
  const result = await sync.signOff()
  toast.add({
    severity: result.ok ? 'success' : 'error',
    summary: result.ok ? '签署完成' : '完整性校验未通过',
    detail: result.message, life: 4500
  })
}

function exportPackage() {
  const payload = { plant: store.plant, equipment: store.equipment, defects: store.defects, audit: store.audit, preflight: store.preflight, syncRecords: sync.records, serverVersion: sync.server?.plantVersion }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = '光伏并网验收交付包.json'; anchor.click(); URL.revokeObjectURL(url)
}
</script>

<template>
  <section class="page">
    <div class="preflight-panel" :class="{ locked: sync.frozen }">
      <div>
        <span>并网前完整性校验（含回传并入状态）</span>
        <strong>{{ store.preflight.allowed ? '全部条件满足，可以签署锁定' : `${store.preflight.blocking.length}项阻断，签署停住` }}</strong>
        <p v-for="item in store.preflight.blocking" :key="item" :class="{ 'conflict-line': item.startsWith('【') }">{{ item }}</p>
        <p v-if="sync.frozen" class="frozen-line">交付版本 V{{ store.plant.version }} 已于回传记录冻结后签署锁定。</p>
      </div>
      <div class="preflight-actions">
        <div class="preflight-sync-state">
          <Tag :value="sync.online ? '网络在线' : '断网暂存'" :severity="sync.online ? 'success' : 'warn'" />
          <Tag :value="`待回传 ${sync.stats.pending}`" :severity="sync.stats.pending ? 'warn' : 'success'" />
          <Tag :value="`冲突 ${sync.stats.conflicts}`" :severity="sync.stats.conflicts ? 'danger' : 'success'" />
          <Tag :value="`已回传 ${sync.stats.merged}`" severity="info" />
        </div>
        <div>
          <Button label="导出交付包" outlined @click="exportPackage" />
          <Button label="签署并锁定版本" :disabled="sync.frozen" @click="sign" />
        </div>
      </div>
    </div>
    <div class="section-head"><div><h2>验收审计</h2><p>当前交付版本 V{{ store.plant.version }} · {{ store.plant.status }} · 签署成功后回传记录冻结</p></div><InputText v-model="keyword" placeholder="搜索实体、动作或操作人" /></div>
    <DataTable :value="rows" dataKey="id" size="small">
      <Column field="createdAt" header="时间"><template #body="{ data }">{{ data.createdAt.replace('T', ' ').slice(0, 16) }}</template></Column>
      <Column field="entityId" header="实体" />
      <Column field="action" header="动作"><template #body="{ data }"><Tag :value="data.action" :severity="data.action.includes('冲突') ? 'danger' : data.action.includes('回传') ? 'info' : 'secondary'" /></template></Column>
      <Column field="operator" header="操作人" />
      <Column field="detail" header="说明" />
    </DataTable>
  </section>
</template>
