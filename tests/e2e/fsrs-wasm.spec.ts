import { expect, test } from '@playwright/test'

async function seedTrainingEvidence(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('wordsbook-db')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('reviewLogs', 'readwrite')
      const store = transaction.objectStore('reviewLogs')
      store.clear()
      for (let word = 0; word < 50; word += 1) {
        for (let day = 0; day < 10; day += 1) {
          const reviewedAt = new Date(Date.UTC(2026, 0, day + 1, 8, word)).toISOString()
          store.add({
            wordId: `wasm-word-${word}`,
            reviewedAt,
            rating: (['again', 'hard', 'good', 'easy'] as const)[(word + day) % 4],
            source: 'flashcard',
            cycleBefore: day,
            cycleAfter: day + 1,
            nextReviewAtBefore: reviewedAt,
            nextReviewAtAfter: reviewedAt,
          })
        }
      }
      transaction.oncomplete = () => { database.close(); resolve() }
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  })
}

test('runs the real FSRS WASM optimizer and returns 21 finite parameters', async ({ page }) => {
  test.setTimeout(180_000)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto('/settings?fsrs-training=1&section=fsrs')
  expect(await page.evaluate(() => ({
    isolated: globalThis.crossOriginIsolated,
    sharedMemory: typeof SharedArrayBuffer !== 'undefined',
  }))).toEqual({ isolated: true, sharedMemory: true })
  await seedTrainingEvidence(page)
  await page.reload()
  await page.evaluate(() => {
    window.addEventListener('wordsbook:fsrs-optimizer-result', (event) => {
      ;(window as typeof window & { __fsrsOptimizerResult?: unknown }).__fsrsOptimizerResult = (event as CustomEvent).detail
    }, { once: true })
  })

  await expect(page.getByText('有效评分').locator('..').getByText('500')).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: '训练个性化参数' }).click()
  const completed = page.getByText(/候选参数.*(已启用|已安全保留当前调度参数)/)
  const failed = page.locator('.sync-message-error')
  await expect(completed.or(failed)).toBeVisible({ timeout: 150_000 })
  if (await failed.isVisible()) {
    await page.locator('.technical-details > summary').click()
    throw new Error(`FSRS optimizer failed: ${await page.locator('.technical-details pre').textContent()}`)
  }

  const saved = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('wordsbook-db')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    return await new Promise<unknown>((resolve, reject) => {
      const request = database.transaction('settings').objectStore('settings').get('fsrsPersonalization')
      request.onsuccess = () => { database.close(); resolve(request.result?.value) }
      request.onerror = () => reject(request.error)
    })
  }) as { activeParameters?: number[]; lastOutcome?: string }

  const optimizerResult = await page.evaluate(() =>
    (window as typeof window & { __fsrsOptimizerResult?: unknown }).__fsrsOptimizerResult,
  ) as { parameterCount?: number; allFinite?: boolean }
  expect(optimizerResult).toEqual({ parameterCount: 21, allFinite: true })
  expect(['active', 'rejected']).toContain(saved.lastOutcome)
  if (saved.lastOutcome === 'active') {
    expect(saved.activeParameters).toHaveLength(21)
    expect(saved.activeParameters?.every(Number.isFinite)).toBe(true)
  }
  expect(pageErrors.join('\n')).not.toMatch(/napi_create_async_work|import function env:/i)
})
