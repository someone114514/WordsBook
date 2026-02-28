import { createRouter, createWebHistory } from 'vue-router'

const LookupView = () => import('../views/LookupView.vue')
const ReviewView = () => import('../views/ReviewView.vue')
const ReviewSessionView = () => import('../views/ReviewSessionView.vue')
const WordbookView = () => import('../views/WordbookView.vue')
const SettingsView = () => import('../views/SettingsView.vue')

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
    { path: '/wordbook', component: WordbookView, meta: { title: '单词本' } },
    { path: '/settings', component: SettingsView, meta: { title: '设置' } },
  ],
})

router.afterEach((to) => {
  document.title = `WordsBook - ${String(to.meta.title ?? 'PWA')}`
})
