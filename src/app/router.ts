import { createRouter, createWebHistory } from 'vue-router'
import SettingsView from '../views/SettingsView.vue'

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', redirect: '/lookup' },
    {
      path: '/lookup',
      component: () => import('../views/LookupView.vue'),
      meta: { title: '查词' },
    },
    {
      path: '/review',
      component: () => import('../views/ReviewView.vue'),
      meta: { title: '背单词' },
    },
    {
      path: '/review/session',
      component: () => import('../views/ReviewSessionView.vue'),
      meta: { title: '背诵中', immersive: true },
    },
    {
      path: '/review/reading',
      component: () => import('../views/ReadingSessionView.vue'),
      meta: { title: '语境阅读', immersive: true },
    },
    {
      path: '/review/reading/history',
      component: () => import('../views/ReadingHistoryView.vue'),
      meta: { title: '文章记录' },
    },
    { path: '/wordbook', redirect: '/review' },
    {
      path: '/lists',
      component: () => import('../views/StudyListsView.vue'),
      meta: { title: '词表' },
    },
    {
      path: '/lists/:listId',
      component: () => import('../views/StudyListDetailView.vue'),
      meta: { title: '词表详情' },
    },
    {
      path: '/settings',
      component: SettingsView,
      meta: { title: '设置' },
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
