<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { BookOpenCheck, LibraryBig, Search, Settings2 } from 'lucide-vue-next'
import GlobalSelectionLookup from '../components/GlobalSelectionLookup.vue'

const route = useRoute()
const router = useRouter()
const appIconUrl = `${import.meta.env.BASE_URL}icons/icon-192.svg`

const tabs = [
  { to: '/lookup', label: '查词', icon: Search },
  { to: '/review', label: '学习', icon: BookOpenCheck },
  { to: '/lists', label: '词表', icon: LibraryBig },
  { to: '/settings', label: '设置', icon: Settings2 },
]

const title = computed(() => String(route.meta.title ?? 'WordsBook'))
const shellMode = computed(() => route.meta.shell ?? 'tab')
const immersiveMode = computed(() => shellMode.value === 'immersive')
const keepAliveViews = ['LookupView', 'ReviewView', 'StudyListsView', 'StudyListDetailView', 'SettingsView']

function navigateTab(path: string, event: MouseEvent): void {
  event.preventDefault()
  if (route.path !== path) {
    void router.push(path)
  }
}
</script>

<template>
  <div class="app-shell selection-lookup-scope" :class="[`app-shell-${shellMode}`, { 'app-shell-immersive': immersiveMode }]">
    <a v-if="!immersiveMode" class="skip-link" href="#main-content">跳转到主内容</a>

    <header v-if="!immersiveMode && shellMode !== 'contextual'" class="topbar" :class="{ 'topbar-large': shellMode === 'tab' }">
      <h1>{{ title }}</h1>
    </header>

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
            @click="navigateTab(tab.to, $event)"
          >
            <component :is="tab.icon" :size="21" :stroke-width="isActive ? 2.35 : 1.8" aria-hidden="true" />
            <span>{{ tab.label }}</span>
          </a>
        </RouterLink>
      </nav>
    </aside>

    <main id="main-content" class="content-area" :class="{ 'content-area-immersive': immersiveMode }">
      <RouterView v-slot="{ Component, route: activeRoute }">
        <Transition :name="immersiveMode ? 'page-zoom' : 'page-slide'" mode="out-in">
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
          @click="navigateTab(tab.to, $event)"
        >
          <component :is="tab.icon" :size="22" :stroke-width="isActive ? 2.4 : 1.8" aria-hidden="true" />
          <span>{{ tab.label }}</span>
        </a>
      </RouterLink>
    </nav>
    <GlobalSelectionLookup />
  </div>
</template>
