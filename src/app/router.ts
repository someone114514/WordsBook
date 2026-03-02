import { createRouter, createWebHistory } from 'vue-router'

import LookupView from '../views/LookupView.vue'
import ReviewView from '../views/ReviewView.vue'
import ReviewSessionView from '../views/ReviewSessionView.vue'
import SettingsView from '../views/SettingsView.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/lookup' },
    { path: '/lookup', component: LookupView, meta: { title: '查词' } },
    { path: '/review', component: ReviewView, meta: { title: '背单词' } },
    {
      path: '/review/session',
      component: ReviewSessionView,
      meta: { title: '背诵中', immersive: true },
    },
    { path: '/wordbook', redirect: '/review' },
    { path: '/settings', component: SettingsView, meta: { title: '设置' } },
  ],
})

router.afterEach((to) => {
  document.title = `WordsBook - ${String(to.meta.title ?? 'PWA')}`
})
