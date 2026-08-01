import { createRouter, createWebHistory } from 'vue-router'
import SettingsView from '../views/SettingsView.vue'

declare module 'vue-router' {
  interface RouteMeta {
    title: string
    shell: 'tab' | 'contextual' | 'immersive'
  }
}

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', redirect: '/lookup' },
    {
      path: '/lookup',
      component: () => import('../views/LookupView.vue'),
      meta: { title: '查词', shell: 'tab' },
    },
    {
      path: '/review',
      component: () => import('../views/ReviewView.vue'),
      meta: { title: '学习', shell: 'tab' },
    },
    {
      path: '/review/session',
      component: () => import('../views/ReviewSessionView.vue'),
      meta: { title: '背诵中', shell: 'immersive' },
    },
    {
      path: '/review/reading',
      component: () => import('../views/ReadingSessionView.vue'),
      meta: { title: '语境阅读', shell: 'immersive' },
    },
    {
      path: '/review/practice',
      component: () => import('../views/PracticeSessionView.vue'),
      meta: { title: '语境练习', shell: 'immersive' },
    },
    {
      path: '/review/reading/history',
      component: () => import('../views/ReadingHistoryView.vue'),
      meta: { title: '文章记录', shell: 'contextual' },
    },
    { path: '/wordbook', redirect: '/review' },
    {
      path: '/lists',
      component: () => import('../views/StudyListsView.vue'),
      meta: { title: '词表', shell: 'tab' },
    },
    {
      path: '/lists/:listId',
      component: () => import('../views/StudyListDetailView.vue'),
      meta: { title: '词表详情', shell: 'contextual' },
    },
    {
      path: '/settings',
      component: SettingsView,
      meta: { title: '设置', shell: 'tab' },
    },
  ],
})

router.onError((error) => {
  if (typeof window === 'undefined') {
    return
  }

  const message = error instanceof Error ? error.message : String(error)
  if (!/dynamically imported module|Importing a module script failed|Failed to fetch/i.test(message)) {
    return
  }

  const reloadKey = 'wordsbook:route-reload-after-import-error'
  if (window.sessionStorage.getItem(reloadKey)) {
    return
  }

  window.sessionStorage.setItem(reloadKey, '1')
  window.location.reload()
})

router.afterEach((to) => {
  if (typeof window !== 'undefined') {
    window.sessionStorage.removeItem('wordsbook:route-reload-after-import-error')
  }
  document.title = `WordsBook - ${String(to.meta.title ?? 'PWA')}`
})
