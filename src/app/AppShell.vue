<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'

const route = useRoute()

const tabs = [
  { to: '/lookup', label: '查词' },
  { to: '/review', label: '背词' },
  { to: '/settings', label: '设置' },
]

const title = computed(() => String(route.meta.title ?? 'WordsBook'))
const immersiveMode = computed(() => Boolean(route.meta.immersive))
const keepAliveViews = ['LookupView', 'ReviewView', 'SettingsView']
</script>

<template>
  <div class="app-shell" :class="{ 'app-shell-immersive': immersiveMode }">
    <a v-if="!immersiveMode" class="skip-link" href="#main-content">跳转到主内容</a>

    <header v-if="!immersiveMode" class="topbar">
      <h1>{{ title }}</h1>
    </header>

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

    <nav v-if="!immersiveMode" class="bottom-nav" aria-label="Main Navigation">
      <RouterLink v-for="tab in tabs" :key="tab.to" :to="tab.to" class="nav-item">
        {{ tab.label }}
      </RouterLink>
    </nav>
  </div>
</template>
