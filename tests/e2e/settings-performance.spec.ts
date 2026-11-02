import { expect, test } from '@playwright/test'

test('reads review history only when the FSRS section is opened', async ({ page }) => {
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.getAll
    ;(window as Window & { reviewHistoryReads: number }).reviewHistoryReads = 0
    IDBObjectStore.prototype.getAll = function (...args) {
      if (this.name === 'reviewLogs') {
        ;(window as Window & { reviewHistoryReads: number }).reviewHistoryReads++
      }
      return original.apply(this, args)
    }
  })
  await page.goto('/settings?section=dictionary')
  await expect(page.locator('#settings-section-dictionary')).toHaveAttribute('open', '')
  await expect(page.locator('#ui-language')).toBeVisible()
  const historyReads = () => page.evaluate(() => (window as Window & { reviewHistoryReads: number }).reviewHistoryReads)
  expect(await historyReads()).toBe(0)
  await page.locator('#settings-section-fsrs summary').first().click()
  await expect.poll(historyReads).toBeGreaterThan(0)
  await expect(page.locator('#settings-section-fsrs .fsrs-summary-row')).toContainText('0/400')
})
