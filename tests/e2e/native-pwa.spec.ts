import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test.describe('native PWA navigation and panels', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
  })

  test('keeps exactly one settings group open and follows section deep links', async ({ page }) => {
    await page.goto('/settings?section=fsrs')
    await expect(page.locator('#settings-section-fsrs')).toHaveAttribute('open', '')
    await expect(page.locator('.settings-group[open]')).toHaveCount(1)

    await page.locator('#settings-section-ai > summary').click()
    await expect(page).toHaveURL(/section=ai/)
    await expect(page.locator('#settings-section-ai')).toHaveAttribute('open', '')
    await expect(page.locator('.settings-group[open]')).toHaveCount(1)

    await page.reload()
    await expect(page.locator('#settings-section-ai')).toHaveAttribute('open', '')
  })

  test('keeps one compact title visible while scrolling', async ({ page }) => {
    await page.goto('/settings?section=dictionary')
    await expect(page.locator('.app-large-title')).toBeHidden()
    const topbar = page.locator('.topbar-compact')
    await expect(topbar.getByRole('heading', { level: 1, name: '设置' })).toBeVisible()
    const topBefore = await topbar.evaluate((element) => element.getBoundingClientRect().top)
    await page.evaluate(() => window.scrollTo(0, Math.min(document.body.scrollHeight, 900)))
    await expect.poll(() => topbar.evaluate((element) => element.getBoundingClientRect().top)).toBe(topBefore)
  })

  test('returns a cold immersive URL to the learning root', async ({ page }) => {
    await page.goto('/review/session')
    await expect(page).toHaveURL(/\/review$/)
    await expect(page.locator('.bottom-nav')).toBeVisible()
    await expect(page.getByRole('heading', { level: 1, name: '今日学习' })).toBeVisible()
  })

  test('reselecting the current tab scrolls to top and switching tabs uses replace semantics', async ({ page }) => {
    await page.goto('/settings?section=dictionary')
    await page.evaluate(() => {
      const original = window.scrollTo.bind(window)
      const calls: ScrollToOptions[] = []
      ;(window as typeof window & { __wordsbookScrollCalls: ScrollToOptions[] }).__wordsbookScrollCalls = calls
      window.scrollTo = ((options: ScrollToOptions) => {
        calls.push(options)
        original(options)
      }) as typeof window.scrollTo
    })

    await page.locator('.bottom-nav').getByRole('link', { name: '设置' }).click()
    await expect.poll(() => page.evaluate(() =>
      (window as typeof window & { __wordsbookScrollCalls: ScrollToOptions[] }).__wordsbookScrollCalls.at(-1)?.top,
    )).toBe(0)

    const historyBefore = await page.evaluate(() => history.length)
    await page.locator('.bottom-nav').getByRole('link', { name: '查词' }).click()
    await page.locator('.bottom-nav').getByRole('link', { name: '设置' }).click()
    expect(await page.evaluate(() => history.length)).toBe(historyBefore)
  })

  test('switches all root tabs repeatedly without a document reload or overlapping pages', async ({ page }) => {
    test.setTimeout(60_000)
    const tabs = [
      { label: '学习', path: '/review' },
      { label: '词表', path: '/lists' },
      { label: '设置', path: '/settings' },
      { label: '查词', path: '/lookup' },
    ]

    const viewports = [
      { width: 375, height: 812 },
      { width: 390, height: 844 },
      { width: 430, height: 932 },
    ]
    await page.setViewportSize(viewports[0])
    await page.goto('/lookup')
    await expect(page.locator('.bottom-nav')).toBeVisible()
    await expect.poll(() => page.evaluate(() => {
      const resources = performance.getEntriesByType('resource').map((entry) => entry.name)
      return ['LookupView-', 'ReviewView-', 'StudyListsView-', 'SettingsView-']
        .every((chunk) => resources.some((resource) => resource.includes(chunk)))
    })).toBe(true)

    // Mount every cached root once before timing repeated tab switches. This
    // keeps the assertion focused on navigation feedback rather than first-use
    // IndexedDB work and module initialization on a shared CI runner.
    for (const target of tabs) {
      await page.locator('.bottom-nav').getByRole('link', { name: target.label }).click()
      await expect.poll(() => new URL(page.url()).pathname).toBe(target.path)
    }

    for (const viewport of viewports) {
      await page.setViewportSize(viewport)

      const navBounds = await page.locator('.bottom-nav').evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return { left: rect.left, right: rect.right, bottom: rect.bottom }
      })
      const latencies: number[] = []

      for (let index = 0; index < 20; index += 1) {
        const target = tabs[index % tabs.length]
        const latency = await page.evaluate(async ({ label, path }) => {
          const link = [...document.querySelectorAll<HTMLAnchorElement>('.bottom-nav .nav-item')]
            .find((item) => item.textContent?.trim() === label)
          if (!link) throw new Error(`Missing tab ${label}`)
          const startedAt = performance.now()
          let routeChangedAt = startedAt
          link.click()
          await new Promise<void>((resolve, reject) => {
            const timeout = window.setTimeout(() => reject(new Error(`Tab did not reach ${path}`)), 1_000)
            const check = () => {
              if (location.pathname === path) {
                routeChangedAt = performance.now()
                requestAnimationFrame(() => requestAnimationFrame(() => {
                  clearTimeout(timeout)
                  resolve()
                }))
                return
              }
              requestAnimationFrame(check)
            }
            check()
          })
          return routeChangedAt - startedAt
        }, target)
        latencies.push(latency)

        const state = await page.evaluate(() => {
          const nav = document.querySelector<HTMLElement>('.bottom-nav')!.getBoundingClientRect()
          const pages = [...document.querySelectorAll<HTMLElement>('.content-area > :not(.app-large-title)')]
            .filter((element) => getComputedStyle(element).display !== 'none')
          return {
            bodyHasContent: (document.querySelector<HTMLElement>('.content-area')?.innerText.trim().length ?? 0) > 0,
            noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
            pageCount: pages.length,
            nav: { left: nav.left, right: nav.right, bottom: nav.bottom },
          }
        })
        expect(state).toEqual({ bodyHasContent: true, noHorizontalOverflow: true, pageCount: 1, nav: navBounds })
      }

      expect(Math.max(...latencies)).toBeLessThan(100)
      expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(1)
    }
  })

  test('restores each tab scroll only within the current session', async ({ page }) => {
    await page.goto('/settings?section=ai')
    await expect(page.locator('#settings-section-ai')).toHaveAttribute('open', '')
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight)).toBe(true)
    await page.evaluate(() => {
      const target = Math.min(420, Math.max(0, document.documentElement.scrollHeight - innerHeight))
      window.scrollTo({ top: target })
    })
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
    const savedTop = await page.evaluate(() => window.scrollY)
    expect(savedTop).toBeGreaterThan(0)

    await page.locator('.bottom-nav').getByRole('link', { name: '查词' }).click()
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
    await page.locator('.bottom-nav').getByRole('link', { name: '设置' }).click()
    await expect.poll(() => page.evaluate((top) => Math.abs(window.scrollY - top), savedTop)).toBeLessThanOrEqual(4)

    await page.evaluate(() => sessionStorage.clear())
    await page.goto('/')
    await expect(page).toHaveURL(/\/settings/)
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
  })

  test('creates a list in an accessible action sheet and reselects its tab to return from detail', async ({ page }) => {
    await page.goto('/lists')
    await page.getByRole('button', { name: '新建词表' }).click()
    const dialog = page.getByRole('dialog', { name: '新建词表' })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('词表名称').fill('原生流程测试')

    const results = await new AxeBuilder({ page }).include('.app-action-sheet').analyze()
    expect(results.violations.filter((item) => ['critical', 'serious'].includes(item.impact ?? ''))).toEqual([])

    await dialog.getByRole('button', { name: '创建词表' }).click()
    await expect(page.getByText('原生流程测试', { exact: true })).toBeVisible()
    await page.getByRole('link', { name: '管理词表：原生流程测试' }).click()
    await expect(page).toHaveURL(/\/lists\/.+/)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '删除词表' }).click()
    const deleteDialog = page.getByRole('dialog', { name: '删除词表？' })
    await expect(deleteDialog).toContainText('单词、长期记忆状态与复习历史都会保留')
    await deleteDialog.getByRole('button', { name: '取消' }).click()
    await page.locator('.bottom-nav').getByRole('link', { name: '词表' }).click()
    await expect(page).toHaveURL(/\/lists$/)
  })

  test('reports offline state without blocking local features', async ({ page, context }) => {
    await page.goto('/lookup')
    await expect(page.getByRole('heading', { level: 1, name: '查词' })).toBeVisible()
    await context.setOffline(true)
    try {
      await page.evaluate(() => window.dispatchEvent(new Event('offline')))
      await expect(page.getByText('当前离线，已下载的词典与学习内容仍可使用。')).toBeVisible()
      await expect(page.getByRole('heading', { level: 1, name: '查词' })).toBeVisible()
    } finally {
      await context.setOffline(false)
      await page.evaluate(() => window.dispatchEvent(new Event('online'))).catch(() => undefined)
    }
  })

  test('starts a controlled deep route from the precached shell with status 200', async ({ page, context, browserName }) => {
    test.skip(browserName === 'webkit', 'Playwright WebKit cannot navigate a controlled page while its context is offline.')
    await page.goto('/lookup')
    await page.evaluate(async () => { await navigator.serviceWorker.ready })
    if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) await page.reload()
    await context.setOffline(true)
    try {
      const response = await page.goto('/settings?section=data', { waitUntil: 'domcontentloaded' })
      expect(response?.status()).toBe(200)
      await expect(page.getByRole('heading', { level: 1, name: '设置' })).toBeVisible()
      await expect(page.locator('#settings-section-data')).toHaveAttribute('open', '')
    } finally {
      await context.setOffline(false)
    }
  })
})
