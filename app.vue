<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useAcceptanceStore } from './stores/acceptance'
import { useSyncStore } from './stores/sync'

const route = useRoute()
const store = useAcceptanceStore()
const sync = useSyncStore()
const title = computed(() => route.path.startsWith('/equipment') ? '设备树与验收项' : route.path.startsWith('/defects') ? '缺陷闭环处置' : route.path.startsWith('/sync') ? '离线回传与合并' : route.path.startsWith('/audit') ? '移交与审计' : '并网验收总览')
onMounted(() => {
  store.hydrate()
  sync.hydrate()
})
</script>

<template>
  <div class="app-shell">
    <aside>
      <div class="brand"><b>光</b><div><strong>并网验收工作台</strong><small>设备、测试、证书与缺陷闭环</small></div></div>
      <nav>
        <NuxtLink to="/"><span>验收总览</span><small>{{ store.stats.total }}项</small></NuxtLink>
        <NuxtLink to="/equipment"><span>设备与测试</span><small>设备树</small></NuxtLink>
        <NuxtLink to="/defects"><span>缺陷闭环</span><small>{{ store.stats.openDefects }}项</small></NuxtLink>
        <NuxtLink to="/sync">
          <span>回传与合并</span>
          <small :class="{ 'badge-alarm': sync.hasConflicts }">{{ sync.stats.conflicts ? `冲突${sync.stats.conflicts}` : sync.stats.pending ? `待传${sync.stats.pending}` : '同步' }}</small>
        </NuxtLink>
        <NuxtLink to="/audit"><span>签署与审计</span><small>V{{ store.plant.version }}</small></NuxtLink>
      </nav>
      <div class="aside-state">
        <span>并网前完整性检查</span>
        <strong :class="{ blocked: !store.preflight.allowed }">{{ store.preflight.allowed ? '允许申请复核' : `${store.preflight.blocking.length}项阻断` }}</strong>
        <small v-if="sync.hasConflicts" class="conflict-note">冲突区 {{ sync.stats.conflicts }} 条未清，检查与签署已停住</small>
        <small>{{ store.plant.name }}</small>
      </div>
    </aside>
    <main>
      <header class="top">
        <div><span>电站工程中心 / 验收与交付</span><h1>{{ title }}</h1></div>
        <div class="top-user">
          <div class="sync-chip-row">
            <span class="sync-chip" :class="sync.online ? 'online' : 'offline'"><i :class="sync.online ? 'pi pi-wifi' : 'pi pi-sign-out'"></i>{{ sync.online ? '在线' : '断网暂存' }}</span>
            <span class="sync-chip crew"><i class="pi pi-users"></i>{{ sync.crew }}</span>
            <span v-if="sync.frozen" class="sync-chip frozen"><i class="pi pi-lock"></i>已签署冻结</span>
            <span v-else-if="sync.hasConflicts" class="sync-chip danger"><i class="pi pi-exclamation-triangle"></i>冲突 {{ sync.stats.conflicts }}</span>
            <span v-else-if="sync.hasPending" class="sync-chip warn"><i class="pi pi-clock"></i>待回传 {{ sync.stats.pending }}</span>
          </div>
          <small>验收负责人</small><strong>陆川</strong>
        </div>
      </header>
      <div v-if="sync.hasConflicts" class="global-conflict-bar" @click="navigateTo('/sync')">
        <i class="pi pi-exclamation-triangle"></i>
        <span><strong>回传冲突未清（{{ sync.stats.conflicts }}条），完整性检查与签署已停住：</strong>{{ sync.conflictBlockers.join('　') }}</span>
        <i class="pi pi-angle-right bar-go"></i>
      </div>
      <NuxtPage />
    </main>
  </div>
</template>
