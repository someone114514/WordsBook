import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RouteLocationNormalizedLoaded, Router } from 'vue-router'
import {
  APP_TAB_ROOTS,
  coldStartRoot,
  contextualBack,
  getSavedTabLocation,
  navigateToTab,
  readPersistentNavigationState,
  rememberRoute,
  tabForPath,
} from './appNavigation'

function route(path: string, tab: 'lookup' | 'review' | 'lists' | 'settings', level: 'root' | 'detail' = 'root') {
  return {
    path,
    fullPath: path,
    meta: { title: tab, shell: level === 'root' ? 'tab' : 'contextual', tab, level },
  } as unknown as RouteLocationNormalizedLoaded
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.restoreAllMocks()
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 240 })
  window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia
  window.scrollTo = vi.fn()
})

describe('native tab navigation state', () => {
  it('maps details to their owning tab and keeps cold starts on a root page', () => {
    expect(tabForPath('/review/reading/history')).toBe('review')
    expect(tabForPath('/lists/example')).toBe('lists')

    rememberRoute(route('/settings', 'settings'), 320)
    expect(coldStartRoot()).toBe('/settings')
    expect(readPersistentNavigationState()).toEqual({ version: 2, lastTab: 'settings' })

    rememberRoute(route('/lists/example', 'lists', 'detail'), 480)
    expect(getSavedTabLocation('lists')).toEqual({ route: '/lists/example', scrollY: 480 })
    expect(coldStartRoot()).toBe('/lists')
  })

  it('reselects a root tab by scrolling to top and a detail tab by replacing its root', async () => {
    const router = { replace: vi.fn().mockResolvedValue(undefined) } as unknown as Router
    await navigateToTab(router, route('/lookup', 'lookup'), 'lookup')
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' })
    expect(router.replace).not.toHaveBeenCalled()

    await navigateToTab(router, route('/lists/example', 'lists', 'detail'), 'lists')
    expect(router.replace).toHaveBeenCalledWith(APP_TAB_ROOTS.lists)
  })

  it('uses replace for tab switches and falls back to the owning root on contextual back', async () => {
    const router = {
      replace: vi.fn().mockResolvedValue(undefined),
      back: vi.fn(),
      resolve: vi.fn((value: string) => ({ path: value })),
    } as unknown as Router

    await navigateToTab(router, route('/lookup', 'lookup'), 'review')
    expect(router.replace).toHaveBeenCalledWith('/review')

    Object.defineProperty(window.history, 'state', { configurable: true, value: { back: '/lookup' } })
    await contextualBack(router, route('/lists/example', 'lists', 'detail'))
    expect(router.replace).toHaveBeenLastCalledWith('/lists')
    expect(router.back).not.toHaveBeenCalled()

    Object.defineProperty(window.history, 'state', { configurable: true, value: { back: '/lists' } })
    await contextualBack(router, route('/lists/example', 'lists', 'detail'))
    expect(router.back).toHaveBeenCalledOnce()
  })

  it('reads the last tab from legacy state without restoring persistent scroll', () => {
    localStorage.setItem('wordsbook:navigation:persistent:v1', JSON.stringify({
      version: 1,
      lastTab: 'lists',
      rootScroll: { lookup: 10, review: 20, lists: 600, settings: 40 },
    }))

    expect(readPersistentNavigationState()).toEqual({ version: 2, lastTab: 'lists' })
    expect(coldStartRoot()).toBe('/lists')
  })
})
