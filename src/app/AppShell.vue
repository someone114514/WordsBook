<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'

const route = useRoute()

const tabs = [
  { to: '/lookup', label: '查词' },
  { to: '/review', label: '背词' },
  { to: '/wordbook', label: '单词本' },
  { to: '/settings', label: '设置' },
]

const title = computed(() => String(route.meta.title ?? 'WordsBook'))
const immersiveMode = computed(() => Boolean(route.meta.immersive))
</script>

<template>
  <div class="app-shell" :class="{ 'app-shell-immersive': immersiveMode }">
    <header v-if="!immersiveMode" class="topbar">
      <h1>{{ title }}</h1>
    </header>

    <main class="content-area" :class="{ 'content-area-immersive': immersiveMode }">
      <RouterView />
    </main>

    <nav v-if="!immersiveMode" class="bottom-nav" aria-label="Main Navigation">
      <RouterLink v-for="tab in tabs" :key="tab.to" :to="tab.to" class="nav-item">
        {{ tab.label }}
      </RouterLink>
    </nav>
  </div>
</template>
