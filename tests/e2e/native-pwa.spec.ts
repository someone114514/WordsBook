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

  test('collapses a scrolling large title into the compact glass bar', async ({ page }) => {
    await page.goto('/settings?section=dictionary')
    await expect(page.locator('.app-large-title h1')).toHaveText('设置')
    await expect(page.locator('.topbar-compact')).not.toHaveClass(/is-collapsed/)
    await page.evaluate(() => window.scrollTo(0, Math.min(document.body.scrollHeight, 900)))
    await expect(page.locator('.topbar-compact')).toHaveClass(/is-collapsed/)
    await expect(page.locator('.topbar-compact > span')).toHaveText('设置')
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
    const card = page.locator('.list-overview-card').filter({ hasText: '原生流程测试' })
    await card.getByRole('link', { name: '管理词表' }).click()
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
