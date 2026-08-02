import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const compact = { width: 390, height: 844 }
const regular = { width: 1440, height: 900 }

async function disableMotion(page: import('@playwright/test').Page): Promise<void> {
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}.app-toast,.app-system-banner{display:none!important}' })
}

async function seedOneStudyWord(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('wordsbook-db')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(['dictionaryEntries', 'wordbook', 'studyListItems'], 'readwrite')
      const now = new Date().toISOString()
      transaction.objectStore('dictionaryEntries').put({
        entryId: 'e2e:native-shell',
        headword: 'native',
        headwordLower: 'native',
        phonetic: '/ˈneɪtɪv/',
        posList: ['adj.'],
        sensesJson: JSON.stringify(['原生的']),
        examplesJson: '[]',
        usageJson: '[]',
      })
      transaction.objectStore('wordbook').put({
        wordId: 'e2e-native-shell',
        entryId: 'e2e:native-shell',
        headword: 'native',
        headwordLower: 'native',
        integrityStatus: 'ready',
        addedAt: now,
        note: '',
        tags: [],
        archived: 0,
      })
      transaction.objectStore('studyListItems').put({
        membershipId: 'system:legacy:e2e-native-shell',
        listId: 'system:legacy',
        wordId: 'e2e-native-shell',
        learningEnabled: 1,
        addedAt: now,
      })
      transaction.oncomplete = () => { database.close(); resolve() }
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  })
}

test('uses a touch tab bar on compact screens without overflow', async ({ page }) => {
  await page.setViewportSize(compact)
  await page.goto('/review')
  await disableMotion(page)

  await expect(page.locator('.bottom-nav')).toBeVisible()
  await expect(page.locator('.app-sidebar')).toBeHidden()
  await expect(page.locator('.bottom-nav .nav-item')).toHaveCount(4)
  const layout = await page.evaluate(() => ({
    noOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
    targets: [...document.querySelectorAll<HTMLElement>('.bottom-nav .nav-item')]
      .every((item) => item.getBoundingClientRect().height >= 44 && item.getBoundingClientRect().width >= 44),
    dockClear: (document.querySelector<HTMLElement>('.study-primary-dock')?.getBoundingClientRect().bottom ?? 0)
      <= (document.querySelector<HTMLElement>('.bottom-nav')?.getBoundingClientRect().top ?? window.innerHeight) + 1,
  }))
  expect(layout).toEqual({ noOverflow: true, targets: true, dockClear: true })
})

test('keeps the adaptive shell stable at tablet breakpoints', async ({ page }) => {
  for (const viewport of [
    { width: 430, height: 932, sidebar: false },
    { width: 768, height: 1024, sidebar: false },
    { width: 1024, height: 768, sidebar: true },
  ]) {
    await page.setViewportSize(viewport)
    await page.goto('/lists')
    if (viewport.sidebar) {
      await expect(page.locator('.app-sidebar')).toBeVisible()
      await expect(page.locator('.bottom-nav')).toBeHidden()
    } else {
      await expect(page.locator('.app-sidebar')).toBeHidden()
      await expect(page.locator('.bottom-nav')).toBeVisible()
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  }
})

test('switches to a sidebar on regular screens', async ({ page }) => {
  await page.setViewportSize(regular)
  await page.goto('/lookup')
  await disableMotion(page)

  await expect(page.locator('.app-sidebar')).toBeVisible()
  await expect(page.locator('.bottom-nav')).toBeHidden()
  const layout = await page.evaluate(() => ({
    noOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
    contentLeft: document.querySelector<HTMLElement>('.content-area')?.getBoundingClientRect().left ?? 0,
    sidebarRight: document.querySelector<HTMLElement>('.app-sidebar')?.getBoundingClientRect().right ?? 0,
  }))
  expect(layout.noOverflow).toBe(true)
  expect(layout.contentLeft).toBeGreaterThanOrEqual(layout.sidebarRight)
})

test('keeps immersive learning free of global chrome', async ({ page }) => {
  await page.setViewportSize(compact)
  await page.goto('/review')
  await expect(page.locator('.bottom-nav')).toBeVisible()
  await seedOneStudyWord(page)
  await page.reload()
  await page.getByRole('button', { name: '开始今日学习' }).click()
  await expect(page.locator('.bottom-nav')).toHaveCount(0)
  await expect(page.locator('.app-sidebar')).toHaveCount(0)
  await expect(page.locator('.topbar')).toHaveCount(0)
})

for (const path of ['/lookup', '/review', '/lists', '/settings']) {
  test(`has no serious automated accessibility violations on ${path}`, async ({ page }) => {
    await page.setViewportSize(compact)
    await page.goto(path)
    await disableMotion(page)
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
    const blocking = results.violations.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
    expect(blocking).toEqual([])
  })
}

test('matches compact core-screen visual baselines', async ({ page }) => {
  test.skip(process.platform !== 'win32', 'Visual baselines are maintained on the Windows reference environment')

  test.setTimeout(75_000)
  await page.setViewportSize(compact)
  await page.goto('/lookup')
  await expect(page.getByPlaceholder('查询单词')).toBeEnabled({ timeout: 45_000 })
  await disableMotion(page)
  await expect(page).toHaveScreenshot('lookup-compact.png', {
    animations: 'disabled',
    mask: [page.locator('.lookup-canvas-footer')],
    maxDiffPixelRatio: 0.02,
  })

  await page.goto('/review')
  await disableMotion(page)
  await expect(page).toHaveScreenshot('review-compact.png', { animations: 'disabled', maxDiffPixelRatio: 0.02 })

  await page.goto('/lists')
  await disableMotion(page)
  await expect(page).toHaveScreenshot('lists-compact.png', { animations: 'disabled', maxDiffPixelRatio: 0.02 })

  await page.goto('/settings?section=fsrs')
  await disableMotion(page)
  await expect(page.locator('.settings-group[open]')).toHaveCount(1)
  await expect(page).toHaveScreenshot('settings-compact.png', { animations: 'disabled', maxDiffPixelRatio: 0.02 })
})

test('matches the regular-width sidebar baseline', async ({ page }) => {
  test.skip(process.platform !== 'win32', 'Visual baselines are maintained on the Windows reference environment')

  await page.setViewportSize(regular)
  await page.goto('/review')
  await disableMotion(page)
  await expect(page).toHaveScreenshot('review-regular.png', { animations: 'disabled', maxDiffPixelRatio: 0.02 })
})
