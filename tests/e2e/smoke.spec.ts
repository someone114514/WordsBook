import { expect, test } from '@playwright/test'

import type { Page } from '@playwright/test'

async function finishCardsUntilCheckpoint(page: Page): Promise<void> {
  for (let step = 0; step < 20; step += 1) {
    const checkpoint = page.getByRole('heading', { name: '今日卡片已完成' })
    const reveal = page.getByRole('button', { name: '显示释义' })
    await expect(checkpoint.or(reveal)).toBeVisible()
    if (await checkpoint.isVisible()) return
    await reveal.click()
    await page.getByRole('button', { name: /记得/ }).click()
  }
  throw new Error('Daily queue did not reach its checkpoint')
}

test('home page loads', async ({ page }) => {
  await page.goto('/lookup')
  await expect(page.getByRole('heading', { level: 1, name: '查词' })).toBeVisible()
})

test('installs the core dictionary and completes lookup to daily review', async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/lookup')

  const search = page.getByPlaceholder('查询单词')
  await expect(search).toBeEnabled({ timeout: 45_000 })
  await search.fill('zyzzyva')
  await search.press('Enter')
  await expect(page.getByRole('heading', { level: 3, name: 'zyzzyva', exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('象鼻虫', { exact: true })).toBeVisible()

  await search.fill('habit')
  await search.press('Enter')

  const habitCard = page.locator('.entry-card').filter({ has: page.getByRole('heading', { level: 3, name: 'habit', exact: true }) }).first()
  await expect(habitCard).toBeVisible()
  await habitCard.getByRole('button', { name: '加入学习', exact: true }).click()
  await expect(page.getByText(/已加入「我的单词」· 将进入每日队列/)).toBeVisible()
  await expect(habitCard.getByText('学习中', { exact: true })).toBeVisible()
  await expect(habitCard.getByRole('button', { name: '已加入学习', exact: true })).toHaveClass(/added/)
  await expect(habitCard.getByRole('button', { name: '已加入学习', exact: true })).toHaveCSS('background-color', 'rgb(241, 245, 249)')
  await expect(habitCard.getByRole('button', { name: '加入其他词表', exact: true })).toBeVisible()

  await page.reload()
  await expect(search).toBeEnabled()
  await search.fill('habit')
  await search.press('Enter')
  const restoredHabitCard = page.locator('.entry-card').filter({ has: page.getByRole('heading', { level: 3, name: 'habit', exact: true }) }).first()
  await expect(restoredHabitCard.getByText('学习中', { exact: true })).toBeVisible()

  await page.getByRole('link', { name: '学习' }).click()
  await expect(page.locator('.study-total strong')).toHaveText('1')
  await page.getByRole('button', { name: '开始今日学习' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'habit' })).toBeVisible()
  await page.getByRole('button', { name: '显示释义' }).click()
  await page.getByRole('button', { name: /记得\s*65%/ }).click()
  await page.getByRole('button', { name: '显示释义' }).click()
  await page.getByRole('button', { name: /记得\s*100%/ }).click()
  await expect(page.getByRole('heading', { name: '今日卡片已完成' })).toBeVisible()
  await page.getByRole('button', { name: '进入今日文章' }).click()
  await expect(page.getByRole('heading', { name: '需要配置 DeepSeek Key' })).toBeVisible()
  await page.getByRole('button', { name: '跳过文章并完成今日学习' }).click()
  await expect(page.getByRole('button', { name: '查看今日学习' })).toBeVisible()
})

test('imports a list and completes the three-grade daily queue without an AI key', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/lists')
  await expect(page.getByRole('heading', { level: 1, name: '词表' })).toBeVisible()

  await page.getByLabel('词表名称').fill('E2E 学习表')
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await page.getByRole('link', { name: '管理词表', exact: true }).last().click()
  await page.getByRole('button', { name: '导入', exact: true }).click()
  await page.getByText('查看 JSON 范例').click()
  await expect(page.getByText(/"words"/)).toBeVisible()
  await page.getByPlaceholder(/粘贴 JSON/).fill(JSON.stringify({ words: [{ word: 'inventedword', meaning: '自造词', tags: ['E2E'] }] }))
  await page.getByRole('button', { name: '预览导入' }).click()
  await page.getByRole('button', { name: '确认导入' }).click()
  await expect(page.getByRole('heading', { name: '导入完成' })).toBeVisible()
  await page.getByRole('button', { name: '查看单词' }).click()
  await expect(page.getByText('inventedword', { exact: true })).toBeVisible()

  await page.getByRole('link', { name: '学习' }).click()
  await expect(page.getByText('今日单词')).toBeVisible()
  await page.getByRole('button', { name: '开始今日学习' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'inventedword' })).toBeVisible()
  await page.getByRole('button', { name: '显示释义' }).click()
  await expect(page.getByRole('button', { name: '移除' })).toBeVisible()
  await expect(page.locator('.review-answer-inline')).toBeVisible()
  await expect(page.locator('.review-memory-grid')).toHaveCount(0)
  await expect(page.locator('.review-grade-dock-three .review-action-btn')).toHaveText([/记得\s*65%/, /模糊\s*25%/, /忘记\s*0%/])
  await expect(page.getByRole('button', { name: /忘记/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /模糊/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /记得/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /太简单/ })).toHaveCount(0)
  await page.getByRole('button', { name: /记得/ }).click()
  await expect(page.getByRole('button', { name: '显示释义' })).toBeVisible()
  await page.getByRole('button', { name: '显示释义' }).click()
  await page.getByRole('button', { name: /记得/ }).click()
  await expect(page.getByRole('heading', { name: '今日卡片已完成' })).toBeVisible()
  await page.getByRole('button', { name: '再学一组' }).click()
  await page.getByRole('button', { name: '再学 5 个' }).click()
  await expect(page.getByText('暂无更多可学单词。')).toBeVisible()
  await page.getByRole('button', { name: '进入今日文章' }).click()
  await expect(page.getByRole('heading', { name: '需要配置 DeepSeek Key' })).toBeVisible()
  await page.getByRole('button', { name: '跳过文章并完成今日学习' }).click()
  await expect(page.getByRole('button', { name: '查看今日学习' })).toBeVisible()
})

test('keeps the started queue stable, applies list changes, and adds another group', async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/lists')
  await page.getByLabel('词表名称').fill('稳定队列表')
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await page.getByRole('link', { name: '管理词表', exact: true }).last().click()
  await page.getByRole('button', { name: '导入', exact: true }).click()
  await page.getByPlaceholder(/粘贴 JSON/).fill(JSON.stringify({ words: [
    { word: 'stableone', meaning: '稳定一' },
    { word: 'stabletwo', meaning: '稳定二' },
    { word: 'stablethree', meaning: '稳定三' },
  ] }))
  await page.getByRole('button', { name: '预览导入' }).click()
  await page.getByRole('button', { name: '确认导入' }).click()

  await page.getByRole('link', { name: '设置' }).click()
  await page.getByLabel('每日新词目标').fill('1')
  await page.getByLabel('每日新词目标').press('Tab')
  await page.getByRole('link', { name: '学习' }).click()
  await expect(page.locator('.study-total strong')).toHaveText('1')
  await expect(page.getByText(/修订号|查词优先|混合比例/)).toHaveCount(0)
  await page.getByRole('button', { name: '开始今日学习' }).click()
  const firstWord = await page.locator('.review-word').textContent()
  await page.getByRole('button', { name: '退出' }).click()
  await page.getByRole('button', { name: '继续今日学习' }).click()
  await expect(page.locator('.review-word')).toHaveText(firstWord ?? '')
  await page.getByRole('button', { name: '退出' }).click()

  await page.getByRole('link', { name: '词表' }).click()
  await page.getByRole('link', { name: '管理词表', exact: true }).last().click()
  await page.getByRole('button', { name: '导入', exact: true }).click()
  await page.getByPlaceholder(/粘贴 JSON/).fill(JSON.stringify({ words: [{ word: 'stablefour', meaning: '稳定四' }] }))
  await page.getByRole('button', { name: '预览导入' }).click()
  await page.getByRole('button', { name: '确认导入' }).click()
  await page.getByRole('link', { name: '学习' }).click()
  await expect(page.getByText(/词表有 .* 个变化/)).toHaveCount(0)
  await expect(page.locator('.study-total strong')).toHaveText('1')
  await page.getByRole('button', { name: '继续今日学习' }).click()
  await finishCardsUntilCheckpoint(page)

  await page.getByRole('button', { name: '再学一组' }).click()
  await page.getByRole('button', { name: '再学 5 个' }).click()
  await expect(page.locator('.review-word')).toBeVisible()
  await finishCardsUntilCheckpoint(page)
  await expect(page.getByRole('heading', { name: '今日卡片已完成' })).toBeVisible()
})
