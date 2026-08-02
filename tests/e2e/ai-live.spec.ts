import { expect, test } from '@playwright/test'

const liveKey = process.env.WORDSBOOK_LIVE_AI_KEY

test.describe('live AI learning experience', () => {
  test.skip(!liveKey, 'Set WORDSBOOK_LIVE_AI_KEY to run the opt-in live AI test.')

  test('generates a covered B2 article and English meaning choices from imported words', async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width: 390, height: 844 })

    await page.goto('/settings')
    const keyInput = page.getByPlaceholder('sk-...')
    await keyInput.fill(liveKey ?? '')
    await page.getByRole('button', { name: '保存 AI 设置', exact: true }).click()
    await expect(page.getByText('AI 设置已保存到当前设备', { exact: true })).toBeVisible()

    await page.goto('/lists')
    await page.getByLabel('词表名称').fill('Live AI 体验测试')
    await page.getByRole('button', { name: '创建', exact: true }).click()
    await page.locator('.list-row-group .list-row-link').last().click()
    await page.getByRole('button', { name: '导入', exact: true }).click()
    await page.getByPlaceholder(/粘贴 JSON/).fill(JSON.stringify({
      words: [
        { word: 'resilient', meaning: '有韧性的' },
        { word: 'tranquil', meaning: '宁静的' },
        { word: 'meticulous', meaning: '一丝不苟的' },
        { word: 'sustain', meaning: '维持；支撑' },
        { word: 'counterintuitive', meaning: '违反直觉的' },
      ],
    }))
    await page.getByRole('button', { name: '预览导入' }).click()
    await page.getByRole('button', { name: '确认导入' }).click()
    await page.getByRole('button', { name: '查看单词', exact: true }).click()
    await expect(page.locator('.word-list-clean label')).toHaveCount(5)

    await page.goto('/review')
    const updateQueue = page.getByRole('button', { name: '更新今日队列', exact: true })
    if (await updateQueue.isVisible()) await updateQueue.click()
    const startLearning = page.getByRole('button', { name: '开始今日学习', exact: true })
      .or(page.getByRole('button', { name: '继续今日学习', exact: true }))
    await startLearning.click()
    const generationState = page.getByText('正文流式生成中，完成后会在下方准备题目')
      .or(page.getByText('读完正文后开始测义'))
      .or(page.getByText('本地预习不生成未经验证的选择题'))
    const enterArticle = page.getByRole('button', { name: '进入今日文章', exact: true })
    const addGroup = page.getByRole('button', { name: '再学一组', exact: true })
    const cardSummary = page.getByRole('heading', { name: '今日卡片已完成', exact: true })
    await expect(generationState.or(cardSummary)).toBeVisible({ timeout: 15_000 })
    if (await cardSummary.isVisible()) {
      await addGroup.click()
      await page.getByRole('button', { name: '再学 5 个', exact: true }).click()
    } else if (await enterArticle.isVisible()) {
      await enterArticle.click()
    }
    await expect(generationState).toBeVisible({ timeout: 90_000 })
    await expect(page.getByText('AI 暂不可用；以下是离线词汇预习，不是生成文章。核心学习仍可继续。')).toHaveCount(0)
    await expect(page.getByText(/未自然覆盖的词将顺延到下一篇/)).toHaveCount(0)
    await expect(page.getByText(/个词已在正文出现，但题目未通过校验/)).toHaveCount(0)
    const headerLayout = await page.locator('.reading-title-row').evaluate((row) => {
      const button = row.querySelector<HTMLButtonElement>('button')!.getBoundingClientRect()
      return {
        noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
        buttonReadable: button.width >= 72 && button.height <= 56,
      }
    })
    expect(headerLayout).toEqual({ noHorizontalOverflow: true, buttonReadable: true })

    await page.getByRole('button', { name: '我已读完，开始测义', exact: true })
      .or(page.getByRole('button', { name: '我已读完，继续学习', exact: true }))
      .click()
    await expect(page.locator('.reading-copy mark')).toHaveCount(5)
    for (let question = 1; question <= 5; question += 1) {
      await expect(page.locator('.quiz-progress-row')).toContainText(`第 ${question} / 5 题`)
      const choices = page.locator('.context-meaning-choice')
      await expect(choices).toHaveCount(3)
      const choiceTexts = await choices.allTextContents()
      expect(choiceTexts.every((choice) => /[a-z]/i.test(choice) && !/[\u3400-\u9fff]/.test(choice))).toBe(true)
      await choices.first().click()
      await page.getByRole('button', {
        name: question < 5 ? '下一题' : '查看全部结果',
        exact: true,
      }).click()
    }
    await expect(page.getByText('答题结果', { exact: true })).toBeVisible()
  })
})
