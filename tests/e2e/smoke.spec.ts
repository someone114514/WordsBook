import { expect, test } from '@playwright/test'

test('home page loads', async ({ page }) => {
  await page.goto('/lookup')
  await expect(page.getByRole('heading', { name: '查词' })).toBeVisible()
})
