import 'fake-indexeddb/auto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../db/database'
import { importUserData } from '../settings/backupService'
import { avoidAdjacentWordInitials, buildTodayPlan, buildTodayPlanCached, invalidateStudyPlanCache, previewCardIntervals } from './reviewService'

const backupFixtureIt = existsSync(resolve('backup/wordsbook-backup-2026-06-08.json')) ? it : it.skip

describe('review data migration', () => {
  beforeEach(async () => {
    db.close()
    await db.delete()
    await db.open()
  })

  backupFixtureIt('replays the 536-word legacy backup into FSRS without importing the API key', async () => {
    const bytes = readFileSync(resolve('backup/wordsbook-backup-2026-06-08.json'))
    await importUserData(new Blob([bytes], { type: 'application/json' }))
    await buildTodayPlan({ at: new Date('2026-07-13T08:00:00.000Z'), dailyNewLimit: 20, dailyReviewLimit: 200 })
    const states = await db.reviewState.toArray()
    expect(states).toHaveLength(536)
    expect(states.every((state) => state.schedulerVersion === 'fsrs-6')).toBe(true)
    expect(await db.reviewLogs.count()).toBe(3372)
    expect(await db.settings.get('deepseekApiKey')).toBeUndefined()
    expect((await db.localSecrets.get('deepseekApiKey'))?.value).toBeUndefined()
  }, 20_000)

  it('keeps priority stable while avoiding adjacent identical initials when alternatives exist', async () => {
    for (const [wordId, headword] of [['a1', 'apple'], ['a2', 'anchor'], ['b1', 'brief'], ['b2', 'bloom']] as const) {
      await db.wordbook.put({ wordId, entryId: `e-${wordId}`, headword, headwordLower: headword, addedAt: '2026-07-15T00:00:00.000Z', note: '', tags: [], archived: 0 })
    }
    expect(await avoidAdjacentWordInitials(['a1', 'a2', 'b1', 'b2'])).toEqual(['a1', 'b1', 'a2', 'b2'])
  })

  it('migrates legacy states through the wordId index without scanning every review log', async () => {
    const now = '2026-07-17T00:00:00.000Z'
    await db.studyLists.put({ listId: 'list', name: 'List', description: '', studyEnabled: 1, createdAt: now, updatedAt: now })
    await db.dictionaryEntries.put({ entryId: 'e1', headword: 'word', headwordLower: 'word', posList: [], sensesJson: '["词"]', examplesJson: '[]', usageJson: '[]' })
    await db.wordbook.put({ wordId: 'w1', entryId: 'e1', headword: 'word', headwordLower: 'word', integrityStatus: 'ready', addedAt: now, note: '', tags: [], archived: 0 })
    await db.studyListItems.put({ membershipId: 'list:w1', listId: 'list', wordId: 'w1', learningEnabled: 1, addedAt: now })
    await db.reviewState.put({ wordId: 'w1', cycle: 0, nextReviewAt: now, successCount: 0, lapseCount: 0, totalReviews: 1 })
    await db.reviewLogs.add({ wordId: 'w1', reviewedAt: now, rating: 'good', cycleBefore: 0, cycleAfter: 0, nextReviewAtBefore: now, nextReviewAtAfter: now })
    const fullScan = vi.spyOn(db.reviewLogs, 'toArray')

    await buildTodayPlan({ at: new Date(now), dailyNewLimit: 10, dailyReviewLimit: 10 })

    expect(fullScan).not.toHaveBeenCalled()
    expect((await db.reviewState.get('w1'))?.schedulerVersion).toBe('fsrs-6')
  })

  it('separates long-term FSRS previews from same-day retry effects', async () => {
    const reviewedAt = new Date('2026-07-20T08:00:00.000Z')
    await db.reviewState.put({
      wordId: 'w-preview', cycle: 0, nextReviewAt: reviewedAt.toISOString(), successCount: 4, lapseCount: 0,
      totalReviews: 4, schedulerVersion: 'fsrs-6', fsrsState: 2, stability: 30, difficulty: 5,
      elapsedDays: 30, scheduledDays: 30, learningSteps: 0, reps: 4, lapses: 0,
      lastReviewedAt: '2026-06-20T08:00:00.000Z',
    })

    const initial = await previewCardIntervals('w-preview', reviewedAt, { attemptNo: 1 })
    expect(initial.good.longTerm).toBeTruthy()
    expect(initial.again.sameDay).toContain('1 分钟')
    expect(initial.good.appliesToLongTerm).toBe(true)

    const retry = await previewCardIntervals('w-preview', reviewedAt, {
      attemptNo: 2,
      canonicalGradeCommitted: true,
    })
    expect(retry.good.longTerm).toBeUndefined()
    expect(retry.again.sameDay).toContain('15 分钟')
    expect(retry.good.appliesToLongTerm).toBe(false)
  })

  const performanceIt = process.env.RUN_PERF_TESTS === '1' ? it : it.skip
  performanceIt('builds a 5k-word plan without touching 50k unrelated logs and serves the warm cache immediately', async () => {
    const now = '2026-07-17T00:00:00.000Z'
    const wordCount = 5_000
    await db.studyLists.put({ listId: 'large', name: 'Large', description: '', studyEnabled: 1, createdAt: now, updatedAt: now })
    await db.settings.bulkPut([{ key: 'dailyNewLimit', value: 20 }, { key: 'dailyReviewLimit', value: 200 }])
    await db.wordbook.bulkPut(Array.from({ length: wordCount }, (_, index) => ({
      wordId: `w-${index}`, entryId: `e-${index}`, headword: `word${index}`, headwordLower: `word${index}`,
      integrityStatus: 'ready' as const, addedAt: now, note: '', tags: [], archived: 0 as const,
    })))
    await db.studyListItems.bulkPut(Array.from({ length: wordCount }, (_, index) => ({
      membershipId: `large:w-${index}`, listId: 'large', wordId: `w-${index}`, learningEnabled: 1 as const, addedAt: now,
    })))
    await db.reviewState.bulkPut(Array.from({ length: wordCount }, (_, index) => ({
      wordId: `w-${index}`, cycle: 0, lastReviewedAt: '2026-07-16T00:00:00.000Z', nextReviewAt: now, successCount: 1, lapseCount: 0, totalReviews: 1,
      schedulerVersion: 'fsrs-5' as const, fsrsState: 2 as const, stability: 10, difficulty: 5, elapsedDays: 1,
      scheduledDays: 1, learningSteps: 0, reps: 1, lapses: 0,
    })))
    for (let batch = 0; batch < 10; batch += 1) {
      await db.reviewLogs.bulkAdd(Array.from({ length: 5_000 }, (_, offset) => {
        const index = batch * 5_000 + offset
        return {
          wordId: `noise-${index}`, reviewedAt: now, rating: 'good' as const, cycleBefore: 0, cycleAfter: 0,
          nextReviewAtBefore: now, nextReviewAtAfter: now,
        }
      }))
    }
    const fullScan = vi.spyOn(db.reviewLogs, 'toArray')
    invalidateStudyPlanCache()
    const started = performance.now()
    const plan = await buildTodayPlanCached()
    const rebuildMs = performance.now() - started
    const warmStarted = performance.now()
    expect(await buildTodayPlanCached()).toBe(plan)
    const warmMs = performance.now() - warmStarted

    expect(fullScan).not.toHaveBeenCalled()
    expect(plan.queueWordIds).toHaveLength(200)
    // fake-indexeddb is substantially slower than Chromium IndexedDB for large bulkGet calls;
    // keep a generous regression ceiling here while the user-visible warm path stays <100ms.
    expect(rebuildMs).toBeLessThan(6_000)
    expect(warmMs).toBeLessThan(100)
  }, 30_000)
})
