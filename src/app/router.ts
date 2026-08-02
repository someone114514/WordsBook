import { createRouter, createWebHistory } from 'vue-router'
import {
  APP_TAB_ROOTS,
  coldStartRoot,
  getSavedTabLocation,
  isAppTab,
  navigationTransition,
  rememberRoute,
  tabForPath,
  type AppTab,
} from './appNavigation'

const appTabLoaders = {
  lookup: () => import('../views/LookupView.vue'),
  review: () => import('../views/ReviewView.vue'),
  lists: () => import('../views/StudyListsView.vue'),
  settings: () => import('../views/SettingsView.vue'),
} satisfies Record<AppTab, () => Promise<unknown>>

export function prefetchAppTab(tab: AppTab): void {
  void appTabLoaders[tab]().catch(() => undefined)
}

export async function prefetchAllAppTabs(): Promise<void> {
  await Promise.allSettled(Object.values(appTabLoaders).map((load) => load()))
}

declare module 'vue-router' {
  interface RouteMeta {
    title: string
    shell: 'tab' | 'contextual' | 'immersive'
    tab: AppTab
    level: 'root' | 'detail' | 'immersive'
    largeTitle?: string
  }
}

let browserHistoryNavigation = false
let initialNavigation = true
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => { browserHistoryNavigation = true })
}

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', redirect: () => coldStartRoot() },
    {
      path: '/lookup',
      component: appTabLoaders.lookup,
      meta: { title: '查词', largeTitle: '查词', shell: 'tab', tab: 'lookup', level: 'root' },
    },
    {
      path: '/review',
      component: appTabLoaders.review,
      meta: { title: '学习', largeTitle: '今日学习', shell: 'tab', tab: 'review', level: 'root' },
    },
    {
      path: '/review/session',
      component: () => import('../views/ReviewSessionView.vue'),
      meta: { title: '背诵中', shell: 'immersive', tab: 'review', level: 'immersive' },
    },
    {
      path: '/review/reading',
      component: () => import('../views/ReadingSessionView.vue'),
      meta: { title: '语境阅读', shell: 'immersive', tab: 'review', level: 'immersive' },
    },
    {
      path: '/review/practice',
      component: () => import('../views/PracticeSessionView.vue'),
      meta: { title: '语境练习', shell: 'immersive', tab: 'review', level: 'immersive' },
    },
    {
      path: '/review/reading/history',
      component: () => import('../views/ReadingHistoryView.vue'),
      meta: { title: '文章记录', shell: 'contextual', tab: 'review', level: 'detail' },
    },
    { path: '/wordbook', redirect: '/review' },
    {
      path: '/lists',
      component: appTabLoaders.lists,
      meta: { title: '词表', largeTitle: '词表', shell: 'tab', tab: 'lists', level: 'root' },
    },
    {
      path: '/lists/:listId',
      component: () => import('../views/StudyListDetailView.vue'),
      meta: { title: '词表详情', shell: 'contextual', tab: 'lists', level: 'detail' },
    },
    {
      path: '/settings',
      component: appTabLoaders.settings,
      meta: { title: '设置', largeTitle: '设置', shell: 'tab', tab: 'settings', level: 'root' },
    },
  ],
  async scrollBehavior(to, _from, savedPosition) {
    const tab = isAppTab(to.meta.tab) ? to.meta.tab : tabForPath(to.path)
    const saved = getSavedTabLocation(tab)
    const target = savedPosition ?? (saved.route === to.fullPath ? { top: saved.scrollY } : { top: 0 })
    const targetTop = 'top' in target ? Number(target.top ?? 0) : 0
    if (targetTop > 0) {
      for (let frame = 0; frame < 12; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        const maximumScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
        if (maximumScroll + 4 >= targetTop) break
      }
    }
    return target
  },
})

router.beforeEach((to, from) => {
  if (from.meta.level && typeof window !== 'undefined') {
    rememberRoute({ fullPath: from.fullPath, meta: { ...from.meta } }, window.scrollY)
  }
  if (initialNavigation) {
    initialNavigation = false
    navigationTransition.value = 'page-none'
    if (to.meta.level === 'immersive') return APP_TAB_ROOTS[to.meta.tab]
  }
  if (browserHistoryNavigation) {
    navigationTransition.value = 'page-back'
    browserHistoryNavigation = false
  } else if (to.meta.level === 'immersive' || from.meta.level === 'immersive') {
    navigationTransition.value = 'page-zoom'
  } else if (to.meta.tab !== from.meta.tab) {
    navigationTransition.value = 'page-none'
  } else if (to.meta.level === 'detail') {
    navigationTransition.value = 'page-forward'
  } else if (from.meta.level === 'detail') {
    navigationTransition.value = 'page-back'
  } else {
    navigationTransition.value = 'page-none'
  }
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
