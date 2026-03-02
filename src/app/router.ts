import { createRouter, createWebHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHistory(),
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
    { path: '/wordbook', redirect: '/review' },
    {
      path: '/settings',
      component: () => import('../views/SettingsView.vue'),
      meta: { title: '设置' },
    },
  ],
})

router.afterEach((to) => {
  document.title = `WordsBook - ${String(to.meta.title ?? 'PWA')}`
})
