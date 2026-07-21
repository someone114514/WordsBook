import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../db/database'
import type { DailyQueueItem } from '../../types/models'
import {
  aggregateSessionRating,
  applyDailyQueueChanges,
  answerDailyCard,
  computeShortTermReview,
  extendDailyQueue,
  finishCardPhase,
  getOrCreateDailySession,
  initialTodayMastery,
  masteryReinsertionGap,
  nextTodayMastery,
  previewDailyQueueChanges,
} from './dailyQueueService'
import { markStudyDataChanged } from './studyDataRevision'

async function seed(words = ['w1']) {
  const now = '2026-07-13T08:00:00.000Z'
  await db.dailyLearningSessions.put({ sessionId: 'daily:test', dayKey: '2026-07-13', status: 'active', phase: 'cards', selectedListIds: [], initialWordIds: words, articleStatus: 'waiting', createdAt: now, updatedAt: now })
  for (const [index, wordId] of words.entries()) {
    await db.dictionaryEntries.put({ entryId: `e-${wordId}`, headword: wordId, headwordLower: wordId, posList: [], sensesJson: '[]', examplesJson: '[]', usageJson: '[]' })
    await db.wordbook.put({ wordId, entryId: `e-${wordId}`, addedAt: now, note: '', tags: [], archived: 0 })
    await db.reviewState.put({ wordId, cycle: 0, nextReviewAt: now, successCount: 0, lapseCount: 0, totalReviews: 0 })
    const item: DailyQueueItem = { itemId: `i-${wordId}`, sessionId: 'daily:test', kind: 'card', wordId, reason: 'initial', position: index, status: 'pending', attemptNo: 1, maxAttempts: 2, retrievability: 0, createdAt: now, updatedAt: now }
    await db.dailyQueueItems.put(item)
  }
}

describe('daily learning queue', () => {
  beforeEach(async () => { db.close(); await db.delete(); await db.open() })

  it('repeats a new word and commits FSRS once only after reaching 100%', async () => {
    await seed()
    let snapshot = await answerDailyCard('daily:test', 'i-w1', 'good', new Date('2026-07-13T08:01:00.000Z'))
    expect(snapshot.current?.reason).toBe('new-repeat')
    snapshot = await answerDailyCard('daily:test', snapshot.current!.itemId, 'good', new Date('2026-07-13T08:02:00.000Z'))
    expect(await db.reviewLogs.where('wordId').equals('w1').count()).toBe(1)
    expect((await db.reviewLogs.where('wordId').equals('w1').first())?.sessionRatings).toEqual(['good', 'good'])
    expect(snapshot.session.phase).toBe('cards')
    snapshot = await finishCardPhase('daily:test')
    expect(snapshot.session.phase).toBe('article')
  })

  it('puts a forgotten word behind two other queue items without a timer', async () => {
    await seed(['w1', 'w2', 'w3', 'w4'])
    const snapshot = await answerDailyCard('daily:test', 'i-w1', 'again', new Date('2026-07-13T08:01:00.000Z'))
    const pending = snapshot.items.filter((item) => item.status === 'pending').map((item) => item.wordId)
    expect(pending).toEqual(['w2', 'w3', 'w1', 'w4'])
    expect(snapshot.items.find((item) => item.reason === 'again-repeat')?.maxAttempts).toBe(5)
  })

  it('uses separate session mastery and long-term trajectory ratings', () => {
    expect([0.2, 0.6, 0.8, 0.95].map((value) => initialTodayMastery(value, false))).toEqual([20, 60, 80, 95])
    expect(initialTodayMastery(0.95, true)).toBe(0)
    expect(nextTodayMastery(0, 'hard')).toBe(25)
    expect(nextTodayMastery(40, 'good')).toBe(75)
    expect(nextTodayMastery(80, 'again')).toBe(0)
    expect([0, 40, 60, 80, 100].map(masteryReinsertionGap)).toEqual([2, 3, 5, 7, 0])
    const afterHard = computeShortTermReview({ mastery: 0, wasNew: true }, 'hard')
    const firstGood = computeShortTermReview({ ...afterHard, wasNew: true }, 'good')
    const secondGood = computeShortTermReview({ ...firstGood, wasNew: true }, 'good')
    expect(afterHard).toEqual(expect.objectContaining({ mastery: 25, recallStreak: 0, weakSeen: true, passed: false }))
    expect(firstGood).toEqual(expect.objectContaining({ mastery: 65, recallStreak: 1, passed: false }))
    expect(secondGood).toEqual(expect.objectContaining({ mastery: 100, recallStreak: 2, passed: true }))
    expect(aggregateSessionRating(['hard', 'good'])).toBe('hard')
    expect(aggregateSessionRating(['good', 'again', 'good'])).toBe('again')
  })

  it('requires two consecutive good recalls after hard before committing FSRS', async () => {
    await seed()
    let snapshot = await answerDailyCard('daily:test', 'i-w1', 'hard', new Date('2026-07-13T08:01:00.000Z'))
    expect(snapshot.current?.todayMastery).toBe(25)
    expect(snapshot.current?.nextGap).toBe(3)
    snapshot = await answerDailyCard('daily:test', snapshot.current!.itemId, 'good', new Date('2026-07-13T08:02:00.000Z'))
    expect(snapshot.current?.todayMastery).toBe(65)
    expect(snapshot.current?.recallStreak).toBe(1)
    expect(await db.reviewLogs.where('wordId').equals('w1').count()).toBe(0)
    snapshot = await answerDailyCard('daily:test', snapshot.current!.itemId, 'good', new Date('2026-07-13T08:03:00.000Z'))
    const log = await db.reviewLogs.where('wordId').equals('w1').first()
    expect(log?.rating).toBe('hard')
    expect(log?.sessionAttemptCount).toBe(3)
    expect(log?.todayMasteryAfter).toBe(100)
    expect(snapshot.session.phase).toBe('cards')
    snapshot = await finishCardPhase('daily:test')
    expect(snapshot.session.phase).toBe('article')
  })

  it('stops after five failures and marks the word for tomorrow', async () => {
    await seed()
    let itemId = 'i-w1'
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const snapshot = await answerDailyCard('daily:test', itemId, 'again', new Date(`2026-07-13T08:0${attempt + 1}:00.000Z`))
      if (snapshot.current) itemId = snapshot.current.itemId
    }
    const attempts = await db.dailyQueueAttempts.where('wordId').equals('w1').toArray()
    const lastItem = (await db.dailyQueueItems.where('wordId').equals('w1').toArray()).sort((a, b) => b.attemptNo - a.attemptNo)[0]
    expect(attempts).toHaveLength(5)
    expect(lastItem?.tomorrowPriority).toBe(true)
    expect(await db.reviewLogs.where('wordId').equals('w1').count()).toBe(1)
  })

  it('keeps a started queue stable and applies real list changes only after confirmation', async () => {
    const now = '2026-07-13T08:00:00.000Z'
    await db.studyLists.put({ listId: 'list', name: 'List', description: '', studyEnabled: 1, createdAt: now, updatedAt: now })
    await db.settings.bulkPut([
      { key: 'dailyNewLimit', value: 2 },
      { key: 'dailyReviewLimit', value: 20 },
    ])
    for (const [index, wordId] of ['w1', 'w2', 'w3'].entries()) {
      await db.dictionaryEntries.put({ entryId: `e-${wordId}`, headword: wordId, headwordLower: wordId, posList: [], sensesJson: '[]', examplesJson: '[]', usageJson: '[]' })
      await db.wordbook.put({ wordId, entryId: `e-${wordId}`, addedAt: new Date(Date.parse(now) + index).toISOString(), note: '', tags: [], archived: 0 })
      await db.reviewState.put({ wordId, cycle: 0, nextReviewAt: now, successCount: 0, lapseCount: 0, totalReviews: 0 })
      await db.studyListItems.put({ membershipId: `list:${wordId}`, listId: 'list', wordId, addedAt: now })
    }

    let snapshot = await getOrCreateDailySession(undefined, new Date(now))
    const sessionId = snapshot.session.sessionId
    expect(snapshot.totalCards).toBe(2)
    await db.settings.put({ key: 'dailyNewLimit', value: 1 })
    await db.studyListItems.delete('list:w1')
    await markStudyDataChanged()

    snapshot = await getOrCreateDailySession(undefined, new Date('2026-07-13T08:01:00.000Z'))
    expect(snapshot.totalCards).toBe(2)
    const changes = await previewDailyQueueChanges(sessionId, new Date('2026-07-13T08:01:00.000Z'))
    expect(changes.removedWordIds).toEqual(['w1'])
    snapshot = await applyDailyQueueChanges(sessionId, new Date('2026-07-13T08:01:00.000Z'))
    expect(snapshot.totalCards).toBe(1)
    expect(snapshot.session.initialWordIds).toEqual(['w2'])
    expect(snapshot.items.filter((item) => item.status === 'pending')).toHaveLength(1)

    snapshot = await answerDailyCard(sessionId, snapshot.current!.itemId, 'hard', new Date('2026-07-13T08:02:00.000Z'))
    await db.studyListItems.delete('list:w2')
    await markStudyDataChanged()
    snapshot = await getOrCreateDailySession(undefined, new Date('2026-07-13T08:03:00.000Z'))
    expect(snapshot.session.sessionId).toBe(sessionId)
    expect(snapshot.attempts).toHaveLength(1)
    expect(snapshot.current?.wordId).toBe('w2')
  })

  it('adds another mixed batch without rebuilding existing queue items', async () => {
    const now = '2026-07-13T08:00:00.000Z'
    await db.studyLists.put({ listId: 'list', name: 'List', description: '', studyEnabled: 1, createdAt: now, updatedAt: now })
    for (const [index, wordId] of ['base', 'due1', 'due2', 'due3', 'new1', 'new2'].entries()) {
      await db.dictionaryEntries.put({ entryId: `e-${wordId}`, headword: wordId, headwordLower: wordId, posList: [], sensesJson: '[]', examplesJson: '[]', usageJson: '[]' })
      await db.wordbook.put({ wordId, entryId: `e-${wordId}`, addedAt: new Date(Date.parse(now) + index).toISOString(), note: '', tags: [], archived: 0 })
      const reviewed = wordId.startsWith('due')
      await db.reviewState.put({ wordId, cycle: 0, lastReviewedAt: reviewed ? new Date(Date.parse(now) - 86_400_000).toISOString() : undefined, nextReviewAt: reviewed ? new Date(Date.parse(now) + 86_400_000).toISOString() : now, successCount: 0, lapseCount: 0, totalReviews: reviewed ? 1 : 0, reps: reviewed ? 1 : 0, schedulerVersion: 'fsrs-5', fsrsState: reviewed ? 2 : 0, stability: reviewed ? 1 : 0, difficulty: 5, elapsedDays: 1, scheduledDays: reviewed ? 1 : 0, learningSteps: 0, lapses: 0 })
      await db.studyListItems.put({ membershipId: `list:${wordId}`, listId: 'list', wordId, source: wordId.startsWith('new') ? 'lookup' : 'migration', addedAt: new Date(Date.parse(now) + index).toISOString() })
    }
    await db.settings.bulkPut([{ key: 'dailyNewLimit', value: 1 }, { key: 'dailyReviewLimit', value: 0 }])
    await markStudyDataChanged()
    let snapshot = await getOrCreateDailySession(undefined, new Date(now))
    const originalItemId = snapshot.current!.itemId
    await db.dailyLearningSessions.update(snapshot.session.sessionId, { articleStatus: 'ready' })
    for (const wordId of ['due1', 'due2', 'due3']) await db.reviewState.update(wordId, { nextReviewAt: now })
    snapshot = await extendDailyQueue(snapshot.session.sessionId, 5, new Date(now))
    expect(snapshot.totalCards).toBe(6)
    expect(snapshot.items.some((item) => item.itemId === originalItemId)).toBe(true)
    const added = snapshot.items.filter((item) => item.reason === 'extra-batch')
    expect(added).toHaveLength(5)
    expect(added.some((item) => item.wasNew)).toBe(true)
    expect(added.some((item) => !item.wasNew)).toBe(true)
    expect(snapshot.session.articleStatus).toBe('stale')
  })

  it('never hot-adds a bulk import to an already started daily queue', async () => {
    const now = '2026-07-13T08:00:00.000Z'
    await db.studyLists.put({ listId: 'list', name: 'List', description: '', studyEnabled: 1, createdAt: now, updatedAt: now })
    await db.settings.bulkPut([{ key: 'dailyNewLimit', value: 1 }, { key: 'dailyReviewLimit', value: 200 }])
    for (const wordId of ['base', ...Array.from({ length: 300 }, (_, index) => `import-${index}`)]) {
      await db.dictionaryEntries.put({ entryId: `e-${wordId}`, headword: wordId, headwordLower: wordId, posList: [], sensesJson: '[]', examplesJson: '[]', usageJson: '[]' })
      await db.wordbook.put({ wordId, entryId: `e-${wordId}`, addedAt: now, note: '', tags: [], archived: 0 })
      await db.reviewState.put({ wordId, cycle: 0, nextReviewAt: now, successCount: 0, lapseCount: 0, totalReviews: 0 })
    }
    await db.studyListItems.put({ membershipId: 'list:base', listId: 'list', wordId: 'base', source: 'manual', addedAt: now })
    await markStudyDataChanged()
    const snapshot = await getOrCreateDailySession(undefined, new Date('2026-07-13T08:01:00.000Z'))
    const importedAt = '2026-07-13T08:02:00.000Z'
    await db.studyListItems.bulkPut(Array.from({ length: 300 }, (_, index) => ({ membershipId: `list:import-${index}`, listId: 'list', wordId: `import-${index}`, source: 'import' as const, learningEnabled: 0 as const, autoActivate: 1 as const, addedAt: importedAt })))
    await markStudyDataChanged()
    const changes = await previewDailyQueueChanges(snapshot.session.sessionId, new Date('2026-07-13T08:03:00.000Z'))
    expect(changes.addedWordIds).toEqual([])
    const applied = await applyDailyQueueChanges(snapshot.session.sessionId, new Date('2026-07-13T08:03:00.000Z'))
    expect(applied.totalCards).toBe(1)
  })

  it('fills the next dynamic round from a later import without disrupting the current round', async () => {
    const now = '2026-07-13T08:00:00.000Z'
    await db.studyLists.put({ listId: 'list', name: 'List', description: '', studyEnabled: 1, createdAt: now, updatedAt: now })
    await db.settings.bulkPut([{ key: 'dailyNewLimit', value: 3 }, { key: 'dailyReviewLimit', value: 20 }])
    await db.dictionaryEntries.put({ entryId: 'e-base', headword: 'base', headwordLower: 'base', posList: [], sensesJson: '[]', examplesJson: '[]', usageJson: '[]' })
    await db.wordbook.put({ wordId: 'base', entryId: 'e-base', addedAt: now, note: '', tags: [], archived: 0 })
    await db.reviewState.put({ wordId: 'base', cycle: 0, nextReviewAt: now, successCount: 0, lapseCount: 0, totalReviews: 0 })
    await db.studyListItems.put({ membershipId: 'list:base', listId: 'list', wordId: 'base', source: 'manual', learningEnabled: 1, autoActivate: 0, addedAt: now })
    await markStudyDataChanged()
    const snapshot = await getOrCreateDailySession(undefined, new Date('2026-07-13T08:01:00.000Z'))
    for (let index = 0; index < 20; index += 1) {
      const wordId = `later-${index}`
      await db.dictionaryEntries.put({ entryId: `e-${wordId}`, headword: wordId, headwordLower: wordId, posList: [], sensesJson: '[]', examplesJson: '[]', usageJson: '[]' })
      await db.wordbook.put({ wordId, entryId: `e-${wordId}`, addedAt: now, note: '', tags: [], archived: 0 })
      await db.reviewState.put({ wordId, cycle: 0, nextReviewAt: now, successCount: 0, lapseCount: 0, totalReviews: 0 })
      await db.studyListItems.put({ membershipId: `list:${wordId}`, listId: 'list', wordId, source: 'import', learningEnabled: 0, autoActivate: 1, addedAt: '2026-07-13T08:02:00.000Z' })
    }
    await markStudyDataChanged()
    const changes = await previewDailyQueueChanges(snapshot.session.sessionId, new Date('2026-07-13T08:03:00.000Z'))
    expect(changes.addedWordIds).toEqual([])
    expect((await db.studyListItems.where('learningEnabled').equals(1).count())).toBe(1)
    let advanced = await answerDailyCard(snapshot.session.sessionId, snapshot.current!.itemId, 'good', new Date('2026-07-13T08:03:00.000Z'))
    advanced = await answerDailyCard(snapshot.session.sessionId, advanced.current!.itemId, 'good', new Date('2026-07-13T08:04:00.000Z'))
    expect(advanced.totalCards).toBe(3)
    expect(advanced.session.activeRoundIndex).toBe(2)
    expect(advanced.items.filter((item) => item.roundIndex === 2 && item.status === 'pending')).toHaveLength(2)
    expect((await db.studyListItems.where('learningEnabled').equals(1).count())).toBe(3)
  })
})
