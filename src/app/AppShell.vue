<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { BookOpenCheck, CloudOff, Download, LibraryBig, Search, Settings2, X } from 'lucide-vue-next'
import GlobalSelectionLookup from '../components/GlobalSelectionLookup.vue'
import AppToastHost from '../components/AppToastHost.vue'
import { notify } from './feedback'
import { navigateToTab, navigationTransition, rememberRoute, type AppTab } from './appNavigation'
import { prefetchAppTab } from './router'
import { setCriticalActivity, useAppLifecycle } from './useAppLifecycle'

const route = useRoute()
const router = useRouter()
const lifecycle = useAppLifecycle()
const { needRefresh, online } = lifecycle
const appIconUrl = `${import.meta.env.BASE_URL}icons/icon-192.svg`

const tabs = [
  { id: 'lookup' as const, to: '/lookup', label: '查词', icon: Search },
  { id: 'review' as const, to: '/review', label: '学习', icon: BookOpenCheck },
  { id: 'lists' as const, to: '/lists', label: '词表', icon: LibraryBig },
  { id: 'settings' as const, to: '/settings', label: '设置', icon: Settings2 },
]

const title = computed(() => String(route.meta.title ?? 'WordsBook'))
const largeTitle = computed(() => String(route.meta.largeTitle ?? title.value))
const shellMode = computed(() => route.meta.shell ?? 'tab')
const level = computed(() => route.meta.level ?? 'root')
const rootPage = computed(() => level.value === 'root')
const immersiveMode = computed(() => shellMode.value === 'immersive')
const keepAliveViews = ['LookupView', 'ReviewView', 'StudyListsView', 'StudyListDetailView', 'SettingsView']

function navigateTab(tab: AppTab, event: MouseEvent): void {
  event.preventDefault()
  void navigateToTab(router, route, tab)
}

function rememberCurrentPage(): void {
  rememberRoute({ fullPath: route.fullPath, meta: { ...route.meta } }, window.scrollY)
}

async function installUpdate(): Promise<void> {
  if (immersiveMode.value || lifecycle.updateBlocked.value) {
    notify('完成当前任务后即可更新，学习进度不会丢失。')
    return
  }
  const applied = await lifecycle.applyServiceWorkerUpdate()
  if (!applied) notify('暂时无法更新，请稍后再试。', { tone: 'error' })
}

watch(immersiveMode, (active) => setCriticalActivity('active-learning', active), { immediate: true })
onMounted(() => {
  window.addEventListener('pagehide', rememberCurrentPage)
})
onBeforeUnmount(() => {
  window.removeEventListener('pagehide', rememberCurrentPage)
  setCriticalActivity('active-learning', false)
})
</script>

<template>
  <div class="app-shell selection-lookup-scope" :class="[`app-shell-${shellMode}`, `app-shell-tab-${route.meta.tab}`, { 'app-shell-immersive': immersiveMode }]">
    <a v-if="!immersiveMode" class="skip-link" href="#main-content">跳转到主内容</a>

    <header v-if="!immersiveMode && shellMode !== 'contextual'" class="topbar topbar-compact">
      <h1>{{ largeTitle }}</h1>
    </header>

    <div v-if="!immersiveMode && !online" class="app-system-banner app-system-banner-offline" role="status">
      <CloudOff :size="18" aria-hidden="true" />
      <span>当前离线，已下载的词典与学习内容仍可使用。</span>
    </div>

    <div v-if="!immersiveMode && needRefresh" class="app-system-banner app-system-banner-update" role="status">
      <Download :size="18" aria-hidden="true" />
      <span>新版本已准备好</span>
      <button type="button" class="btn btn-primary" @click="installUpdate">立即更新</button>
      <button type="button" class="icon-button" aria-label="下次启动时更新" @click="lifecycle.deferServiceWorkerUpdate">
        <X :size="18" aria-hidden="true" />
      </button>
    </div>

    <aside v-if="!immersiveMode" class="app-sidebar" aria-label="WordsBook 主导航">
      <RouterLink class="sidebar-brand" to="/lookup" aria-label="WordsBook 首页">
        <img class="sidebar-brand-mark" :src="appIconUrl" alt="" />
        <span><strong>WordsBook</strong><small>每日语言学习</small></span>
      </RouterLink>
      <nav class="sidebar-nav" aria-label="主导航">
        <RouterLink v-for="tab in tabs" :key="tab.to" :to="tab.to" custom v-slot="{ href, isActive, isExactActive }">
          <a
            :href="href"
            class="sidebar-nav-item"
            :class="{ 'router-link-active': isActive, 'router-link-exact-active': isExactActive }"
            @pointerdown="prefetchAppTab(tab.id)"
            @click="navigateTab(tab.id, $event)"
          >
            <component :is="tab.icon" :size="21" :stroke-width="isActive ? 2.35 : 1.8" aria-hidden="true" />
            <span>{{ tab.label }}</span>
          </a>
        </RouterLink>
      </nav>
    </aside>

    <main id="main-content" class="content-area" :class="{ 'content-area-immersive': immersiveMode }">
      <div v-if="rootPage && !immersiveMode" class="app-large-title">
        <h1>{{ largeTitle }}</h1>
      </div>
      <RouterView v-slot="{ Component, route: activeRoute }">
        <Transition
          :name="navigationTransition"
          :css="navigationTransition !== 'page-none'"
        >
          <component v-if="Component && immersiveMode" :is="Component" :key="activeRoute.fullPath" />
          <KeepAlive v-else :include="keepAliveViews">
            <component v-if="Component" :is="Component" :key="activeRoute.path" />
          </KeepAlive>
        </Transition>
      </RouterView>
    </main>

    <nav v-if="!immersiveMode" class="bottom-nav" aria-label="主导航">
      <RouterLink v-for="tab in tabs" :key="tab.to" :to="tab.to" custom v-slot="{ href, isActive, isExactActive }">
        <a
          :href="href"
          class="nav-item"
          :class="{ 'router-link-active': isActive, 'router-link-exact-active': isExactActive }"
          @pointerdown="prefetchAppTab(tab.id)"
          @click="navigateTab(tab.id, $event)"
        >
          <component :is="tab.icon" :size="22" :stroke-width="isActive ? 2.4 : 1.8" aria-hidden="true" />
          <span>{{ tab.label }}</span>
        </a>
      </RouterLink>
    </nav>
    <GlobalSelectionLookup />
    <AppToastHost />
  </div>
</template>
