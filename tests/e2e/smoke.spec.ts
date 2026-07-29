import { expect, test } from '@playwright/test'

import type { Page } from '@playwright/test'

async function finishLocalReading(page: Page): Promise<void> {
  await expect(page.getByText('AI 暂不可用；以下是离线词汇预习，不是生成文章。核心学习仍可继续。')).toBeVisible()
  await page.getByRole('button', { name: '我已读完，继续学习' }).click()
  await page.getByRole('button', { name: '继续学习', exact: true }).click()
}

async function finishLocalPractice(page: Page): Promise<void> {
  const recalled = page.locator('.context-choice-list button').first()
  const continueLearning = page.getByRole('button', { name: '继续学习', exact: true })
  if (!await recalled.isVisible() && !await continueLearning.isVisible()) return
  if (!await continueLearning.isVisible()) {
    await expect(recalled).toBeEnabled()
    await recalled.click({ force: true, timeout: 2_000 }).catch(() => undefined)
  }
  if (await continueLearning.isVisible()) {
    await continueLearning.click({ force: true, timeout: 2_000 }).catch(() => undefined)
  }
}

async function finishLearningFlow(page: Page): Promise<void> {
  for (let step = 0; step < 30; step += 1) {
    const completed = page.getByRole('button', { name: '查看今日学习' })
    const localReading = page.getByRole('button', { name: '我已读完，继续学习' })
    const localPractice = page.locator('.context-choice-list')
    const reveal = page.getByRole('button', { name: '显示释义' })
    const enterArticle = page.getByRole('button', { name: '进入今日文章' })
    const returnHome = page.getByRole('button', { name: '返回学习首页' })
    await expect(completed.or(localReading).or(localPractice).or(reveal).or(enterArticle).or(returnHome))
      .toBeVisible({ timeout: 15_000 })
    if (await completed.isVisible()) return
    if (await enterArticle.isVisible()) {
      await enterArticle.click()
      continue
    }
    if (await returnHome.isVisible()) {
      // Completion handlers route back to /review; this checkpoint can be a
      // one-frame liveQuery state whose button detaches during the transition.
      await page.waitForTimeout(100)
      continue
    }
    if (await localReading.isVisible()) {
      await finishLocalReading(page)
      continue
    }
    if (await localPractice.isVisible()) {
      await finishLocalPractice(page)
      continue
    }
    if (await reveal.isVisible()) {
      await reveal.click()
      await page.getByRole('button', { name: '记得，按 Good 评分' }).click()
    }
  }
  throw new Error('Daily learning flow did not complete')
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

  await search.fill('exquisite')
  await search.press('Enter')

  const wordCard = page.locator('.entry-card').filter({ has: page.getByRole('heading', { level: 3, name: 'exquisite', exact: true }) }).first()
  await expect(wordCard).toBeVisible()
  await wordCard.getByRole('button', { name: '加入学习', exact: true }).click()
  await expect(page.getByText(/已加入「我的单词」· 将进入每日队列/)).toBeVisible()
  await expect(wordCard.getByText('学习中', { exact: true })).toBeVisible()
  await expect(wordCard.getByRole('button', { name: '已加入学习', exact: true })).toHaveClass(/added/)
  await expect(wordCard.getByRole('button', { name: '已加入学习', exact: true })).toHaveCSS('background-color', 'rgb(241, 245, 249)')
  await expect(wordCard.getByRole('button', { name: '加入其他词表', exact: true })).toBeVisible()

  await page.reload()
  await expect(search).toBeEnabled()
  await search.fill('exquisite')
  await search.press('Enter')
  const restoredWordCard = page.locator('.entry-card').filter({ has: page.getByRole('heading', { level: 3, name: 'exquisite', exact: true }) }).first()
  await expect(restoredWordCard.getByText('学习中', { exact: true })).toBeVisible()

  await page.getByRole('link', { name: '学习' }).click()
  await expect(page.locator('.study-total strong')).toHaveText('1')
  await page.getByRole('button', { name: '开始今日学习' }).click()
  await finishLocalReading(page)
  await expect(page.getByRole('heading', { level: 1, name: 'exquisite' })).toBeVisible()
  await page.getByRole('button', { name: '显示释义' }).click()
  const mobileLayout = await page.evaluate(() => {
    const word = document.querySelector<HTMLElement>('.review-word')!.getBoundingClientRect()
    const answer = document.querySelector<HTMLElement>('.review-answer-inline')!.getBoundingClientRect()
    const content = document.querySelector<HTMLElement>('.review-card-content-revealed')!.getBoundingClientRect()
    const summaries = [...document.querySelectorAll<HTMLElement>('.review-secondary-definition summary')]
      .map((summary) => summary.getBoundingClientRect())
    return {
      noOverlap: word.bottom <= answer.top,
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
      answerInsideCard: answer.left >= content.left && answer.right <= content.right + 1,
      summariesReadable: summaries.every((summary) => summary.width >= 100 && summary.height <= 64),
    }
  })
  expect(mobileLayout).toEqual({
    noOverlap: true,
    noHorizontalOverflow: true,
    answerInsideCard: true,
    summariesReadable: true,
  })
  await page.getByRole('button', { name: '记得，按 Good 评分' }).click()
  if (await page.locator('.context-choice-list').isVisible({ timeout: 5_000 }).catch(() => false)) {
    await finishLocalPractice(page)
  }
  await expect(page.getByRole('button', { name: '查看今日学习' })).toBeVisible()
})

test('imports a list and completes the four-grade daily queue without an AI key', async ({ page }) => {
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
  await finishLocalReading(page)
  await expect(page.getByRole('heading', { level: 1, name: 'inventedword' })).toBeVisible()
  await page.getByRole('button', { name: '显示释义' }).click()
  await expect(page.getByRole('button', { name: '移除' })).toBeVisible()
  await expect(page.locator('.review-answer-inline')).toBeVisible()
  await expect(page.getByRole('button', { name: 'AI 优化释义' })).toBeDisabled()
  await expect(page.getByText('配置 DeepSeek Key 后可用')).toBeVisible()
  await expect(page.locator('.review-memory-grid')).toHaveCount(0)
  await expect(page.locator('.review-grade-dock-four .review-action-btn')).toHaveCount(4)
  await expect(page.getByRole('button', { name: '不知道，按 Again 评分' })).toBeVisible()
  await expect(page.getByRole('button', { name: '模糊，按 Hard 评分' })).toBeVisible()
  await expect(page.getByRole('button', { name: '记得，按 Good 评分' })).toBeVisible()
  await expect(page.getByRole('button', { name: '秒懂，按 Easy 评分' })).toBeVisible()
  await page.getByRole('button', { name: '记得，按 Good 评分' }).click()
  if (await page.locator('.context-choice-list').isVisible({ timeout: 5_000 }).catch(() => false)) {
    await finishLocalPractice(page)
  }
  await expect(page.getByRole('button', { name: '查看今日学习' })).toBeVisible()
  await page.getByRole('button', { name: '查看今日学习' }).click()
  await expect(page.getByRole('heading', { name: '今天还想再学一点？' })).toBeVisible()
  await page.getByRole('button', { name: '再学一组' }).click()
  await page.getByRole('button', { name: '再学 5 个' }).click()
  await expect(page.getByText('暂无更多可学单词。')).toBeVisible()
})

test('keeps the started queue stable, applies list changes, and adds another group', async ({ page }) => {
  test.setTimeout(90_000)
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
  await finishLocalReading(page)
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
  await finishLearningFlow(page)
  await page.getByRole('button', { name: '查看今日学习' }).click()

  await page.getByRole('button', { name: '再学一组' }).click()
  await page.getByRole('button', { name: '再学 5 个' }).click()
  await finishLearningFlow(page)
  await expect(page.getByRole('button', { name: '查看今日学习' })).toBeVisible()
})
