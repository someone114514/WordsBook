import { ref } from 'vue'
import type { RouteLocationNormalizedLoaded, Router } from 'vue-router'

export type AppTab = 'lookup' | 'review' | 'lists' | 'settings'
export type AppNavigationTransition = 'page-none' | 'page-forward' | 'page-back' | 'page-zoom'

interface StoredTabLocation {
  route: string
  scrollY: number
}

interface SessionNavigationState {
  version: 1
  tabs: Record<AppTab, StoredTabLocation>
}

interface PersistentNavigationState {
  version: 2
  lastTab: AppTab
}

const SESSION_KEY = 'wordsbook:navigation:session:v1'
const PERSISTENT_KEY = 'wordsbook:navigation:persistent:v2'
const LEGACY_PERSISTENT_KEY = 'wordsbook:navigation:persistent:v1'

export const APP_TAB_ROOTS: Record<AppTab, string> = {
  lookup: '/lookup',
  review: '/review',
  lists: '/lists',
  settings: '/settings',
}

export const navigationTransition = ref<AppNavigationTransition>('page-none')

function defaultSessionState(): SessionNavigationState {
  return {
    version: 1,
    tabs: {
      lookup: { route: '/lookup', scrollY: 0 },
      review: { route: '/review', scrollY: 0 },
      lists: { route: '/lists', scrollY: 0 },
      settings: { route: '/settings', scrollY: 0 },
    },
  }
}

function defaultPersistentState(): PersistentNavigationState {
  return {
    version: 2,
    lastTab: 'lookup',
  }
}

function safeParse<T>(storage: Storage | undefined, key: string, fallback: T): T {
  if (!storage) return fallback
  try {
    const parsed = JSON.parse(storage.getItem(key) ?? '') as T
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

export function isAppTab(value: unknown): value is AppTab {
  return typeof value === 'string' && value in APP_TAB_ROOTS
}

export function tabForPath(path: string): AppTab {
  if (path === '/review' || path.startsWith('/review/')) return 'review'
  if (path === '/lists' || path.startsWith('/lists/')) return 'lists'
  if (path === '/settings') return 'settings'
  return 'lookup'
}

function validRouteForTab(tab: AppTab, route: unknown): route is string {
  if (typeof route !== 'string' || !route.startsWith('/')) return false
  return tabForPath(route.split('?')[0] ?? route) === tab
}

export function readSessionNavigationState(storage = typeof sessionStorage === 'undefined' ? undefined : sessionStorage): SessionNavigationState {
  const fallback = defaultSessionState()
  const parsed = safeParse<Partial<SessionNavigationState>>(storage, SESSION_KEY, fallback)
  if (parsed.version !== 1 || !parsed.tabs) return fallback
  for (const tab of Object.keys(APP_TAB_ROOTS) as AppTab[]) {
    const candidate = parsed.tabs[tab]
    if (candidate && validRouteForTab(tab, candidate.route) && Number.isFinite(candidate.scrollY)) {
      fallback.tabs[tab] = { route: candidate.route, scrollY: Math.max(0, candidate.scrollY) }
    }
  }
  return fallback
}

export function readPersistentNavigationState(storage = typeof localStorage === 'undefined' ? undefined : localStorage): PersistentNavigationState {
  const fallback = defaultPersistentState()
  if (storage?.getItem(PERSISTENT_KEY)) {
    const parsed = safeParse<Partial<PersistentNavigationState>>(storage, PERSISTENT_KEY, fallback)
    if (parsed.version === 2 && isAppTab(parsed.lastTab)) return { version: 2, lastTab: parsed.lastTab }
  }

  const legacy = safeParse<{ version?: number; lastTab?: unknown }>(storage, LEGACY_PERSISTENT_KEY, {})
  if (legacy.version === 1 && isAppTab(legacy.lastTab)) fallback.lastTab = legacy.lastTab
  return fallback
}

function saveSessionState(state: SessionNavigationState): void {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(state))
}

function savePersistentState(state: PersistentNavigationState): void {
  localStorage.setItem(PERSISTENT_KEY, JSON.stringify(state))
}

export function rememberRoute(route: Pick<RouteLocationNormalizedLoaded, 'fullPath' | 'meta'>, scrollY: number): void {
  if (typeof window === 'undefined' || route.meta.level === 'immersive') return
  const tab = isAppTab(route.meta.tab) ? route.meta.tab : tabForPath(route.fullPath)
  const session = readSessionNavigationState()
  session.tabs[tab] = { route: route.fullPath, scrollY: Math.max(0, scrollY) }
  saveSessionState(session)
  const persistent = readPersistentNavigationState()
  persistent.lastTab = tab
  savePersistentState(persistent)
}

export function coldStartRoot(): string {
  const persistent = readPersistentNavigationState()
  return APP_TAB_ROOTS[persistent.lastTab]
}

export function getSavedTabLocation(tab: AppTab): StoredTabLocation {
  return readSessionNavigationState().tabs[tab]
}

export async function navigateToTab(router: Router, route: RouteLocationNormalizedLoaded, tab: AppTab): Promise<void> {
  const currentTab = isAppTab(route.meta.tab) ? route.meta.tab : tabForPath(route.path)
  if (currentTab === tab) {
    if (route.meta.level !== 'root') {
      navigationTransition.value = 'page-back'
      await router.replace(APP_TAB_ROOTS[tab])
      return
    }
    window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    rememberRoute(route, 0)
    return
  }
  navigationTransition.value = 'page-none'
  const saved = getSavedTabLocation(tab)
  await router.replace(validRouteForTab(tab, saved.route) ? saved.route : APP_TAB_ROOTS[tab])
}

export async function contextualBack(router: Router, route: RouteLocationNormalizedLoaded): Promise<void> {
  const tab = isAppTab(route.meta.tab) ? route.meta.tab : tabForPath(route.path)
  const previous = typeof window.history.state?.back === 'string' ? window.history.state.back : ''
  if (previous && tabForPath(router.resolve(previous).path) === tab) {
    navigationTransition.value = 'page-back'
    router.back()
    return
  }
  navigationTransition.value = 'page-back'
  await router.replace(APP_TAB_ROOTS[tab])
}
