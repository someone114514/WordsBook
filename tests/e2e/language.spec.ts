import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('GitHub Pages starts in English and remembers language changes', async ({ page }) => {
  await page.route('https://wordsbook.github.io/**', async (route) => {
    const url = new URL(route.request().url())
    const response = await route.fetch({ url: `http://127.0.0.1:4173${url.pathname}${url.search}` })
    await route.fulfill({ response })
  })
  await page.goto('https://wordsbook.github.io/settings')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.locator('#ui-language')).toHaveValue('en')
  await expect(page.locator('.sidebar-nav')).toContainText('Settings')
  await expect(page).toHaveTitle('WordsBook - Settings')

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    for (const section of ['dictionary', 'fsrs', 'ai', 'sync', 'data']) {
      await page.locator(`#settings-section-${section} summary`).first().click()
      await expect(page.locator(`#settings-section-${section}`)).toHaveAttribute('open', '')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    }
    await page.screenshot({ path: `test-results/settings-en-${width}.png`, fullPage: true })
  }

  await page.locator('#ui-language').selectOption('zh-CN')
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(page.locator('.bottom-nav')).toContainText('设置')
  await page.reload()
  await expect(page.locator('#ui-language')).toHaveValue('zh-CN')
  await expect(page).toHaveTitle('WordsBook - 设置')
  await page.locator('#ui-language').selectOption('en')
  await expect(page.locator('.bottom-nav')).toContainText('Settings')
  await page.locator('.bottom-nav a[href="/lists"]').click()
  await expect(page.getByRole('heading', { name: 'Lists', exact: true }).first()).toBeVisible()
  await expect(page.getByText('My words', { exact: true })).toBeVisible()
  await page.locator('.bottom-nav a[href="/review"]').click()
  await expect(page.getByRole('heading', { name: 'Today’s study', exact: true }).first()).toBeVisible()
  await page.locator('.bottom-nav a[href="/lookup"]').click()
  await expect(page.getByRole('textbox', { name: 'Word search input' })).toHaveAttribute('placeholder', 'Look up a word')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
})
