import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../db/database'
import type { DailyQueueItem } from '../../types/models'
import {
  aggregateSessionRating,
  applyDailyQueueChanges,
  answerDailyCard,
  computeShortTermReview,
  extendDailyQueue,
  getOrCreateDailySession,
  initialTodayMastery,
  masteryReinsertionGap,
  nextTodayMastery,
  previewDailyQueueChanges,
  replanUnstartedDailyQueue,
  reconcileStudyDay,
  resumeDailyCardsAfterArticle,
  resumeDailyCardsAfterPractice,
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

  it('commits the first unprompted grade immediately and does not overlearn a successful new word', async () => {
    await seed()
    const snapshot = await answerDailyCard('daily:test', 'i-w1', 'good', new Date('2026-07-13T08:01:00.000Z'))
    expect(await db.reviewLogs.where('wordId').equals('w1').count()).toBe(1)
    expect((await db.reviewLogs.where('wordId').equals('w1').first())?.sessionRatings).toEqual(['good'])
    expect(snapshot.items.filter((item) => item.status === 'pending')).toHaveLength(0)
    expect(snapshot.session.phase).toBe('cards')
  })

  it('adds a forgotten word as an O(1) scheduled retry instead of rewriting the queue', async () => {
    await seed(['w1', 'w2', 'w3', 'w4'])
    const snapshot = await answerDailyCard('daily:test', 'i-w1', 'again', new Date('2026-07-13T08:01:00.000Z'))
    const pending = snapshot.items.filter((item) => item.status === 'pending').map((item) => item.wordId)
    expect(pending).toEqual(['w2', 'w3', 'w4', 'w1'])
    expect(snapshot.items.find((item) => item.reason === 'again-repeat')).toMatchObject({
      maxAttempts: 3,
      eligibleAfterOrdinal: 4,
      notBeforeAt: '2026-07-13T08:02:00.000Z',
    })
    expect(await db.reviewLogs.where('wordId').equals('w1').count()).toBe(1)
  })

  it('uses explainable pass/retry states rather than a second mastery model', () => {
    expect([0.2, 0.6, 0.8, 0.95].map((value) => initialTodayMastery(value, false))).toEqual([20, 60, 80, 95])
    expect(initialTodayMastery(0.95, true)).toBe(0)
    expect(nextTodayMastery(0, 'hard')).toBe(25)
    expect(nextTodayMastery(40, 'good')).toBe(100)
    expect(nextTodayMastery(80, 'again')).toBe(0)
    expect([0, 40, 60, 80, 100].map(masteryReinsertionGap)).toEqual([2, 3, 5, 7, 0])
    const afterHard = computeShortTermReview({ mastery: 0, wasNew: true }, 'hard')
    const firstGood = computeShortTermReview({ ...afterHard, wasNew: true }, 'good')
    expect(afterHard).toEqual(expect.objectContaining({ mastery: 25, recallStreak: 0, weakSeen: true, passed: false }))
    expect(firstGood).toEqual(expect.objectContaining({ mastery: 100, recallStreak: 1, passed: true }))
    expect(aggregateSessionRating(['hard', 'good'])).toBe('hard')
    expect(aggregateSessionRating(['good', 'again', 'good'])).toBe('again')
  })

  it('commits Hard once and keeps later retry evidence out of FSRS', async () => {
    await seed()
    let snapshot = await answerDailyCard('daily:test', 'i-w1', 'hard', new Date('2026-07-13T08:01:00.000Z'))
    expect(snapshot.current?.todayMastery).toBe(25)
    expect(snapshot.current?.nextGap).toBe(5)
    expect((await db.reviewLogs.where('wordId').equals('w1').first())?.rating).toBe('hard')
    snapshot = await answerDailyCard('daily:test', snapshot.current!.itemId, 'good', new Date('2026-07-13T08:02:00.000Z'))
    const log = await db.reviewLogs.where('wordId').equals('w1').first()
    expect(log?.rating).toBe('hard')
    expect(await db.reviewLogs.where('wordId').equals('w1').count()).toBe(1)
    expect(snapshot.attempts.filter((attempt) => attempt.committedToFsrs)).toHaveLength(1)
    expect(snapshot.session.phase).toBe('cards')
  })

  it('stops hard testing after repeated failures and marks the word for tomorrow', async () => {
    await seed()
    let itemId = 'i-w1'
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = await answerDailyCard('daily:test', itemId, 'again', new Date(`2026-07-13T08:0${attempt + 1}:00.000Z`))
      if (attempt === 1) {
        const microReview = snapshot.items.find((item) => item.status === 'pending' && item.wordId === 'w1')
        expect(microReview).toMatchObject({
          coachingRequired: true,
          notBeforeAt: '2026-07-13T08:17:00.000Z',
        })
      }
      if (snapshot.current) itemId = snapshot.current.itemId
    }
    const attempts = await db.dailyQueueAttempts.where('wordId').equals('w1').toArray()
    const lastItem = (await db.dailyQueueItems.where('wordId').equals('w1').toArray()).sort((a, b) => b.attemptNo - a.attemptNo)[0]
    expect(attempts).toHaveLength(3)
    expect(lastItem?.tomorrowPriority).toBe(true)
    expect(await db.reviewLogs.where('wordId').equals('w1').count()).toBe(1)
  })

  it('never exceeds the review limit or duplicates newly due words across concurrent reconciles', async () => {
    const start = '2026-07-28T08:00:00.000Z'
    await db.settings.bulkPut([
      { key: 'dailyNewLimit', value: 0 },
      { key: 'dailyReviewLimit', value: 4 },
      { key: 'roundWordCount', value: 8 },
    ])
    await db.studyLists.put({
      listId: 'list',
      name: 'List',
      description: '',
      studyEnabled: 1,
      createdAt: start,
      updatedAt: start,
    })
    for (const [index, wordId] of ['due-1', 'due-2', 'later-1', 'later-2', 'later-3'].entries()) {
      const dueAt = index < 2
        ? start
        : index < 4 ? '2026-07-28T10:00:00.000Z' : '2026-07-28T12:00:00.000Z'
      await db.dictionaryEntries.put({
        entryId: `e-${wordId}`,
        headword: wordId,
        headwordLower: wordId,
        posList: ['n'],
        sensesJson: '["词"]',
        examplesJson: '[]',
        usageJson: '[]',
      })
      await db.wordbook.put({
        wordId,
        entryId: `e-${wordId}`,
        headword: wordId,
        headwordLower: wordId,
        addedAt: start,
        note: '',
        tags: [],
        archived: 0,
      })
      await db.reviewState.put({
        wordId,
        cycle: 0,
        nextReviewAt: dueAt,
        successCount: 1,
        lapseCount: 0,
        totalReviews: 1,
        reps: 1,
        schedulerVersion: 'fsrs-5',
      })
      await db.studyListItems.put({
        membershipId: `list:${wordId}`,
        listId: 'list',
        wordId,
        learningEnabled: 1,
        addedAt: start,
      })
    }

    const initial = await getOrCreateDailySession(['list'], new Date(start))
    expect(initial.totalCards).toBe(2)
    await Promise.all([
      reconcileStudyDay(new Date('2026-07-28T11:00:00.000Z')),
      reconcileStudyDay(new Date('2026-07-28T11:00:00.000Z')),
    ])
    await reconcileStudyDay(new Date('2026-07-28T13:00:00.000Z'))
    const session = await db.dailyLearningSessions.get(initial.session.sessionId)
    const items = await db.dailyQueueItems.where('sessionId').equals(initial.session.sessionId).toArray()
    expect(new Set(session?.initialWordIds).size).toBe(4)
    expect(new Set(items.filter((item) => !item.wasNew && item.wordId).map((item) => item.wordId)).size).toBe(4)
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

    snapshot = await resumeDailyCardsAfterArticle(sessionId, new Date('2026-07-13T08:01:30.000Z'))
    snapshot = await answerDailyCard(sessionId, snapshot.current!.itemId, 'hard', new Date('2026-07-13T08:02:00.000Z'))
    await db.studyListItems.delete('list:w2')
    await markStudyDataChanged()
    snapshot = await getOrCreateDailySession(undefined, new Date('2026-07-13T08:03:00.000Z'))
    expect(snapshot.session.sessionId).toBe(sessionId)
    expect(snapshot.attempts).toHaveLength(1)
    expect(snapshot.items.some((item) => item.wordId === 'w2' && item.tomorrowPriority)).toBe(true)
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
    snapshot = await resumeDailyCardsAfterArticle(snapshot.session.sessionId, new Date('2026-07-13T08:00:30.000Z'))
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

  it('refreshes the remaining daily plan from a later import without disrupting completed cards', async () => {
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
    expect(changes.addedWordIds).toEqual(['later-0', 'later-1'])
    expect((await db.studyListItems.where('learningEnabled').equals(1).count())).toBe(1)
    let advanced = await resumeDailyCardsAfterArticle(snapshot.session.sessionId, new Date('2026-07-13T08:02:30.000Z'))
    advanced = await answerDailyCard(snapshot.session.sessionId, advanced.current!.itemId, 'good', new Date('2026-07-13T08:03:00.000Z'))
    advanced = await applyDailyQueueChanges(snapshot.session.sessionId, new Date('2026-07-13T08:05:00.000Z'))
    expect(advanced.totalCards).toBe(4)
    expect(advanced.session.activeRoundIndex).toBe(2)
    expect(advanced.items.filter((item) => item.roundIndex === 2 && item.status === 'pending')).toHaveLength(3)
    expect((await db.studyListItems.where('learningEnabled').equals(1).count())).toBe(4)
  })

  it('replans an untouched legacy fixed queue under the current new-word limit', async () => {
    const now = '2026-07-13T08:00:00.000Z'
    await db.studyLists.put({ listId: 'list', name: 'List', description: '', studyEnabled: 1, createdAt: now, updatedAt: now })
    await db.settings.bulkPut([{ key: 'dailyNewLimit', value: 2 }, { key: 'dailyReviewLimit', value: 0 }])
    for (const [index, wordId] of ['old-1', 'old-2', 'old-3', 'lookup-new'].entries()) {
      await db.dictionaryEntries.put({ entryId: `e-${wordId}`, headword: wordId, headwordLower: wordId, posList: [], sensesJson: '[]', examplesJson: '[]', usageJson: '[]' })
      await db.wordbook.put({ wordId, entryId: `e-${wordId}`, addedAt: new Date(Date.parse(now) + index).toISOString(), note: '', tags: [], archived: 0 })
      await db.reviewState.put({ wordId, cycle: 0, nextReviewAt: now, successCount: 0, lapseCount: 0, totalReviews: 0 })
      await db.studyListItems.put({
        membershipId: `list:${wordId}`,
        listId: 'list',
        wordId,
        source: wordId === 'lookup-new' ? 'lookup' : 'manual',
        learningEnabled: 1,
        addedAt: new Date(Date.parse(now) + index).toISOString(),
      })
    }
    await seed(['old-1', 'old-2', 'old-3'])
    const session = await db.dailyLearningSessions.get('daily:test')
    await db.dailyLearningSessions.put({ ...session!, selectedListIds: ['list'], activeRoundIndex: 1, roundsJson: JSON.stringify([{ index: 1, wordIds: ['old-1', 'old-2', 'old-3'], status: 'active', startedAt: now }]) })
    await markStudyDataChanged()

    const snapshot = await replanUnstartedDailyQueue('daily:test', new Date('2026-07-13T08:01:00.000Z'))
    const pending = snapshot.items.filter((item) => item.status === 'pending').map((item) => item.wordId)
    expect(pending).toHaveLength(2)
    expect(pending).toContain('lookup-new')
    expect(snapshot.session.initialWordIds).toEqual(pending)
    expect(snapshot.items.filter((item) => item.reason === 'initial' && item.status === 'skipped')).toHaveLength(3)
    expect(snapshot.session.activeRoundIndex).toBe(1)
    expect(snapshot.current?.wordId).toBeDefined()
  })

  it('keeps v2 learning-unit membership intact when a replan has no source delta', async () => {
    await seed(['w1', 'w2'])
    const unitId = 'daily:test:unit:1'
    const units = [{
      unitId,
      index: 0,
      wordIds: ['w1', 'w2'],
      dueWordIds: ['w1', 'w2'],
      newWordIds: [],
      status: 'active' as const,
    }]
    await db.dailyLearningSessions.update('daily:test', {
      engineVersion: 2,
      sessionRevision: 4,
      activityOrdinal: 0,
      learningStage: 'probe',
      activeUnitIndex: 0,
      unitsJson: JSON.stringify(units),
    })
    await db.dailyQueueItems.update('i-w1', { unitId, stage: 'probe' })
    await db.dailyQueueItems.update('i-w2', { unitId, stage: 'probe' })

    const snapshot = await replanUnstartedDailyQueue('daily:test', new Date('2026-07-13T08:01:00.000Z'))
    expect(JSON.parse(snapshot.session.unitsJson ?? '[]')).toEqual(units)
    expect(snapshot.session.activeUnitIndex).toBe(0)
    expect(snapshot.session.sessionRevision).toBe(4)
    expect(snapshot.items.filter((item) => item.status === 'pending').map((item) => item.unitId))
      .toEqual([unitId, unitId])
  })

  it('lets one ten-word article introduce two five-word new-card units without repeating it', async () => {
    const now = '2026-07-13T08:00:00.000Z'
    const wordIds = Array.from({ length: 10 }, (_, index) => `new-${index + 1}`)
    const units = [0, 1].map((index) => ({
      unitId: `u${index + 1}`,
      index,
      wordIds: wordIds.slice(index * 5, index * 5 + 5),
      dueWordIds: [],
      newWordIds: wordIds.slice(index * 5, index * 5 + 5),
      status: index === 0 ? 'active' as const : 'pending' as const,
    }))
    for (const wordId of wordIds) {
      await db.dictionaryEntries.put({
        entryId: `e-${wordId}`,
        headword: wordId,
        headwordLower: wordId,
        posList: [],
        sensesJson: '["词义"]',
        examplesJson: '[]',
        usageJson: '[]',
      })
      await db.wordbook.put({
        wordId,
        entryId: `e-${wordId}`,
        headword: wordId,
        headwordLower: wordId,
        addedAt: now,
        note: '',
        tags: [],
        archived: 0,
      })
    }
    await db.dailyLearningSessions.put({
      sessionId: 'daily:2026-07-13',
      dayKey: '2026-07-13',
      status: 'active',
      phase: 'article',
      engineVersion: 2,
      sessionRevision: 1,
      activityOrdinal: 0,
      learningStage: 'read',
      activeUnitIndex: 0,
      activeRoundIndex: 1,
      activeReadingBatchIndex: 0,
      unitsJson: JSON.stringify(units),
      readingBatchesJson: JSON.stringify([wordIds]),
      readingBatchPlanVersion: 2,
      selectedListIds: [],
      initialWordIds: wordIds,
      articleStatus: 'completed',
      createdAt: now,
      updatedAt: now,
    })
    await db.readingSessions.put({
      sessionId: 'reading:2026-07-13:0:0',
      dayKey: '2026-07-13',
      batchIndex: 0,
      selectionSeed: 0,
      level: 'B2',
      topic: '',
      targetWordIds: [],
      status: 'completed',
      title: 'Ten words',
      segmentsJson: JSON.stringify(wordIds.map((wordId) => ({ text: wordId, wordId }))),
      targetsJson: '[]',
      translation: '',
      createdAt: now,
      updatedAt: now,
    })
    await db.dailyQueueItems.bulkPut(units[1]!.wordIds.map((wordId, index) => ({
      itemId: `i-${wordId}`,
      sessionId: 'daily:2026-07-13',
      kind: 'card' as const,
      wordId,
      reason: 'initial' as const,
      unitId: 'u2',
      stage: 'learn' as const,
      eligibleAfterOrdinal: 0,
      position: index,
      status: 'pending' as const,
      attemptNo: 1,
      maxAttempts: 3,
      retrievability: 0,
      createdAt: now,
      updatedAt: now,
    })))

    await resumeDailyCardsAfterArticle('daily:2026-07-13', new Date(now))
    const snapshot = await getOrCreateDailySession(undefined, new Date(now))
    const restoredUnits = JSON.parse(snapshot.session.unitsJson ?? '[]') as Array<{ articleCompletedAt?: string }>

    expect(restoredUnits.every((unit) => unit.articleCompletedAt === now)).toBe(true)
    expect(snapshot.session).toMatchObject({
      phase: 'cards',
      learningStage: 'learn',
      activeUnitIndex: 1,
      activeReadingBatchIndex: 0,
    })
    expect(snapshot.current?.unitId).toBe('u2')
  })

  it('combines prior passage coverage when a missing-word recovery article is skipped', async () => {
    const now = '2026-07-13T08:00:00.000Z'
    await db.dailyLearningSessions.put({
      sessionId: 'daily:2026-07-13',
      dayKey: '2026-07-13',
      status: 'active',
      phase: 'article',
      engineVersion: 2,
      sessionRevision: 1,
      learningStage: 'read',
      activeUnitIndex: 0,
      activeReadingBatchIndex: 1,
      unitsJson: JSON.stringify([{
        unitId: 'u1', index: 0, wordIds: ['w1', 'w2'],
        dueWordIds: [], newWordIds: ['w1', 'w2'], status: 'active',
      }]),
      readingBatchesJson: JSON.stringify([['w1', 'w2'], ['w2']]),
      readingBatchPlanVersion: 2,
      selectedListIds: [],
      initialWordIds: ['w1', 'w2'],
      articleStatus: 'skipped',
      createdAt: now,
      updatedAt: now,
    })
    await db.readingSessions.put({
      sessionId: 'reading:2026-07-13:0:0',
      dayKey: '2026-07-13',
      batchIndex: 0,
      selectionSeed: 0,
      level: 'B2',
      topic: '',
      targetWordIds: ['w1'],
      status: 'completed',
      title: 'Partial',
      segmentsJson: '[]',
      targetsJson: '[]',
      translation: '',
      createdAt: now,
      updatedAt: now,
    })
    await db.dailyQueueItems.put({
      itemId: 'i-w1',
      sessionId: 'daily:2026-07-13',
      kind: 'card',
      wordId: 'w1',
      reason: 'initial',
      unitId: 'u1',
      stage: 'learn',
      position: 0,
      status: 'pending',
      attemptNo: 1,
      maxAttempts: 3,
      retrievability: 0,
      createdAt: now,
      updatedAt: now,
    })

    const snapshot = await resumeDailyCardsAfterArticle('daily:2026-07-13', new Date(now))
    expect(JSON.parse(snapshot.session.unitsJson ?? '[]')[0]?.articleCompletedAt).toBe(now)
  })

  it('opens a missing-word recovery before completing the final learning unit', async () => {
    const now = '2026-07-13T08:00:00.000Z'
    await db.dailyLearningSessions.put({
      sessionId: 'daily:2026-07-13',
      dayKey: '2026-07-13',
      status: 'active',
      phase: 'article',
      engineVersion: 2,
      sessionRevision: 1,
      learningStage: 'read',
      activeUnitIndex: 0,
      activeReadingBatchIndex: 0,
      unitsJson: JSON.stringify([{
        unitId: 'u1', index: 0, wordIds: ['w1', 'w2'],
        dueWordIds: [], newWordIds: ['w1', 'w2'], status: 'active',
      }]),
      readingBatchesJson: JSON.stringify([['w1', 'w2'], ['w2']]),
      readingBatchPlanVersion: 2,
      selectedListIds: [],
      initialWordIds: ['w1', 'w2'],
      articleStatus: 'completed',
      createdAt: now,
      updatedAt: now,
    })
    await db.readingSessions.put({
      sessionId: 'reading:2026-07-13:0:0',
      dayKey: '2026-07-13',
      batchIndex: 0,
      selectionSeed: 0,
      level: 'B2',
      topic: '',
      targetWordIds: ['w1'],
      status: 'completed',
      title: 'Partial',
      segmentsJson: '[]',
      targetsJson: '[]',
      translation: '',
      createdAt: now,
      updatedAt: now,
    })

    const snapshot = await resumeDailyCardsAfterArticle('daily:2026-07-13', new Date(now))
    expect(snapshot.session).toMatchObject({
      status: 'active',
      phase: 'article',
      learningStage: 'read',
      activeReadingBatchIndex: 1,
    })
  })

  it('opens an interleaved article at the configured round boundary and resumes cards afterward', async () => {
    await seed()
    await db.settings.bulkPut([{ key: 'articleEveryRounds', value: 2 }, { key: 'roundWordCount', value: 10 }])
    await db.dailyLearningSessions.update('daily:test', {
      activeRoundIndex: 4,
      roundsJson: JSON.stringify([
        { index: 1, wordIds: Array.from({ length: 7 }, (_, index) => `old-a-${index}`), status: 'completed' },
        { index: 2, wordIds: Array.from({ length: 6 }, (_, index) => `old-b-${index}`), status: 'completed' },
        { index: 3, wordIds: ['done'], status: 'completed' },
        { index: 4, wordIds: ['w1'], status: 'active' },
      ]),
    })
    await db.dailyQueueItems.update('i-w1', { roundIndex: 4 })

    let snapshot = await answerDailyCard('daily:test', 'i-w1', 'good', new Date('2026-07-13T08:01:00.000Z'))
    expect(snapshot.session.phase).toBe('article')
    expect(snapshot.session.activeReadingBatchIndex).toBe(2)

    snapshot = await resumeDailyCardsAfterArticle('daily:test', new Date('2026-07-13T08:03:00.000Z'))
    expect(snapshot.session.phase).toBe('summary')
  })

  it('repairs legacy migrated rounds so only the current round is active', async () => {
    const now = '2026-07-13T08:00:00.000Z'
    await seed(['w1', 'w2', 'w3'])
    await db.dailyQueueItems.update('i-w1', { roundIndex: 1, status: 'completed' })
    await db.dailyQueueItems.update('i-w2', { roundIndex: 2 })
    await db.dailyQueueItems.update('i-w3', { roundIndex: 3 })
    await db.dailyLearningSessions.update('daily:test', {
      activeRoundIndex: 2,
      roundsJson: JSON.stringify([
        { index: 1, wordIds: ['w1'], status: 'active', startedAt: now },
        { index: 2, wordIds: ['w2'], status: 'active', startedAt: now },
        { index: 3, wordIds: ['w3'], status: 'active', startedAt: now },
      ]),
    })

    const snapshot = await getOrCreateDailySession(undefined, new Date('2026-07-13T08:01:00.000Z'))
    const rounds = JSON.parse(snapshot.session.roundsJson ?? '[]') as Array<{ index: number; status: string }>
    expect(rounds.map((round) => round.status)).toEqual(['completed', 'active', 'pending'])
    expect(snapshot.current?.wordId).toBe('w2')
  })

  it('makes an Again retry eligible across the rolling pool after three different activities and 60 seconds', async () => {
    const now = '2026-07-20T08:00:00.000Z'
    await db.studyLists.put({ listId: 'list', name: 'List', description: '', studyEnabled: 1, createdAt: now, updatedAt: now })
    await db.settings.bulkPut([
      { key: 'dailyNewLimit', value: 0 },
      { key: 'dailyReviewLimit', value: 20 },
      { key: 'roundWordCount', value: 8 },
    ])
    for (const [index, wordId] of Array.from({ length: 12 }, (_, value) => `w${value + 1}`).entries()) {
      await db.dictionaryEntries.put({ entryId: `e-${wordId}`, headword: `word${index}`, headwordLower: `word${index}`, posList: [], sensesJson: '["词"]', examplesJson: '[]', usageJson: '[]' })
      await db.wordbook.put({ wordId, entryId: `e-${wordId}`, headword: `word${index}`, headwordLower: `word${index}`, addedAt: now, note: '', tags: [], archived: 0 })
      await db.studyListItems.put({ membershipId: `list:${wordId}`, listId: 'list', wordId, learningEnabled: 1, addedAt: now })
      await db.reviewState.put({
        wordId,
        cycle: 0,
        lastReviewedAt: '2026-07-18T08:00:00.000Z',
        nextReviewAt: now,
        successCount: 1,
        lapseCount: 0,
        totalReviews: 1,
        schedulerVersion: 'fsrs-5',
        fsrsState: 2,
        stability: 1,
        difficulty: 5,
        elapsedDays: 2,
        scheduledDays: 1,
        learningSteps: 0,
        reps: 1,
        lapses: 0,
      })
    }

    let snapshot = await getOrCreateDailySession(undefined, new Date(now))
    const failedWordId = snapshot.current!.wordId
    snapshot = await answerDailyCard(snapshot.session.sessionId, snapshot.current!.itemId, 'again', new Date(now))
    for (let index = 0; index < 3; index += 1) {
      snapshot = await answerDailyCard(
        snapshot.session.sessionId,
        snapshot.current!.itemId,
        'good',
        new Date(`2026-07-20T08:01:0${index + 1}.000Z`),
      )
    }
    expect(snapshot.current?.wordId).toBe(failedWordId)
    expect(snapshot.current?.stage).toBe('retry')
    expect(snapshot.current?.eligibleAfterOrdinal).toBe(4)
  })

  it('defers only ordinal-blocked terminal retries and preserves time-only retries', async () => {
    const now = '2026-07-20T08:00:00.000Z'
    await db.dailyLearningSessions.put({
      sessionId: 'daily:mixed-retries',
      dayKey: '2026-07-20',
      status: 'active',
      phase: 'practice',
      engineVersion: 2,
      sessionRevision: 1,
      activityOrdinal: 1,
      learningStage: 'transfer',
      activeUnitIndex: 0,
      activeRoundIndex: 1,
      pendingPracticeRoundIndex: 1,
      pendingPracticeSessionId: 'practice:mixed',
      unitsJson: JSON.stringify([{
        unitId: 'u1',
        index: 0,
        wordIds: ['w1', 'w2'],
        dueWordIds: ['w1', 'w2'],
        newWordIds: [],
        status: 'completed',
      }]),
      selectedListIds: [],
      initialWordIds: ['w1', 'w2'],
      articleStatus: 'completed',
      createdAt: now,
      updatedAt: now,
    })
    await db.dailyQueueItems.bulkPut([
      {
        itemId: 'ordinal-blocked',
        sessionId: 'daily:mixed-retries',
        kind: 'card',
        wordId: 'w1',
        reason: 'context-retry',
        unitId: 'u1',
        stage: 'retry',
        eligibleAfterOrdinal: 4,
        notBeforeAt: '2026-07-20T08:01:00.000Z',
        position: 1,
        status: 'pending',
        attemptNo: 2,
        maxAttempts: 3,
        retrievability: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        itemId: 'time-only',
        sessionId: 'daily:mixed-retries',
        kind: 'card',
        wordId: 'w2',
        reason: 'again-repeat',
        unitId: 'u1',
        stage: 'retry',
        eligibleAfterOrdinal: 1,
        notBeforeAt: '2026-07-20T08:02:00.000Z',
        position: 2,
        status: 'pending',
        attemptNo: 2,
        maxAttempts: 3,
        retrievability: 0,
        createdAt: now,
        updatedAt: now,
      },
    ])

    const snapshot = await resumeDailyCardsAfterPractice(
      'daily:mixed-retries',
      new Date(now),
    )

    expect(snapshot.session).toMatchObject({ status: 'active', phase: 'cards', learningStage: 'retry' })
    expect(snapshot.items.find((item) => item.itemId === 'ordinal-blocked')).toMatchObject({
      status: 'skipped',
      tomorrowPriority: true,
    })
    const timeOnly = snapshot.items.find((item) => item.itemId === 'time-only')
    expect(timeOnly).toMatchObject({ status: 'pending' })
    expect(timeOnly?.tomorrowPriority).not.toBe(true)
    expect(snapshot.nextAvailableAt).toBe('2026-07-20T08:02:00.000Z')
  })

  it('keeps a 500-word answer mutation O(1)', async () => {
    const now = '2026-07-20T08:00:00.000Z'
    const wordIds = Array.from({ length: 500 }, (_, index) => `w-${index}`)
    await db.dailyLearningSessions.put({
      sessionId: 'daily:large',
      dayKey: '2026-07-20',
      status: 'active',
      phase: 'cards',
      engineVersion: 2,
      sessionRevision: 1,
      activityOrdinal: 0,
      learningStage: 'probe',
      activeUnitIndex: 0,
      unitsJson: JSON.stringify([{ unitId: 'u1', index: 0, wordIds, dueWordIds: wordIds, newWordIds: [], status: 'active' }]),
      selectedListIds: [],
      initialWordIds: wordIds,
      articleStatus: 'waiting',
      createdAt: now,
      updatedAt: now,
    })
    await db.dailyQueueItems.bulkPut(wordIds.map((wordId, position) => ({
      itemId: `i-${wordId}`,
      sessionId: 'daily:large',
      kind: 'card' as const,
      wordId,
      reason: 'initial' as const,
      unitId: 'u1',
      stage: 'probe' as const,
      eligibleAfterOrdinal: 0,
      position,
      status: 'pending' as const,
      attemptNo: 1,
      maxAttempts: 3,
      retrievability: 0,
      createdAt: now,
      updatedAt: now,
    })))
    await db.reviewState.put({ wordId: 'w-0', cycle: 0, nextReviewAt: now, successCount: 0, lapseCount: 0, totalReviews: 0 })
    const bulkPut = vi.spyOn(db.dailyQueueItems, 'bulkPut')
    await answerDailyCard('daily:large', 'i-w-0', 'again', new Date(now))
    expect(bulkPut).not.toHaveBeenCalled()
  })

  it('rolls unfinished retries into today without deleting submitted evidence', async () => {
    const yesterday = '2026-07-21T08:00:00.000Z'
    const today = new Date('2026-07-23T08:00:00.000Z')
    await db.studyLists.put({ listId: 'list', name: 'List', description: '', studyEnabled: 1, createdAt: yesterday, updatedAt: yesterday })
    await db.dictionaryEntries.put({ entryId: 'e1', headword: 'apple', headwordLower: 'apple', posList: ['n'], sensesJson: '["苹果"]', examplesJson: '[]', usageJson: '[]' })
    await db.wordbook.put({ wordId: 'w1', entryId: 'e1', headword: 'apple', headwordLower: 'apple', addedAt: yesterday, note: '', tags: [], archived: 0 })
    await db.studyListItems.put({ membershipId: 'list:w1', listId: 'list', wordId: 'w1', learningEnabled: 1, addedAt: yesterday })
    await db.reviewState.put({ wordId: 'w1', cycle: 0, lastReviewedAt: yesterday, nextReviewAt: '2026-08-01T00:00:00.000Z', successCount: 1, lapseCount: 1, totalReviews: 2, reps: 2, schedulerVersion: 'fsrs-5', fsrsState: 2, stability: 1, difficulty: 6, elapsedDays: 1, scheduledDays: 1, learningSteps: 0, lapses: 1 })
    await db.reviewLogs.add({ wordId: 'w1', reviewedAt: yesterday, rating: 'again', source: 'flashcard', cycleBefore: 0, cycleAfter: 0, nextReviewAtBefore: yesterday, nextReviewAtAfter: '2026-08-01T00:00:00.000Z' })
    await db.dailyLearningSessions.put({ sessionId: 'daily:old', dayKey: '2026-07-21', status: 'active', phase: 'cards', engineVersion: 2, sessionRevision: 1, activityOrdinal: 1, learningStage: 'retry', activeUnitIndex: 0, unitsJson: JSON.stringify([{ unitId: 'u1', index: 0, wordIds: ['w1'], dueWordIds: ['w1'], newWordIds: [], status: 'completed' }]), selectedListIds: ['list'], initialWordIds: ['w1'], articleStatus: 'completed', createdAt: yesterday, updatedAt: yesterday })
    await db.dailyQueueItems.put({ itemId: 'retry', sessionId: 'daily:old', kind: 'card', wordId: 'w1', reason: 'again-repeat', unitId: 'u1', stage: 'retry', eligibleAfterOrdinal: 4, position: 1, status: 'pending', attemptNo: 2, maxAttempts: 3, retrievability: 0, createdAt: yesterday, updatedAt: yesterday })
    await db.dailyQueueAttempts.put({ attemptId: 'attempt', sessionId: 'daily:old', itemId: 'old', wordId: 'w1', rating: 'again', committedToFsrs: true, activityOrdinal: 1, answeredAt: yesterday })

    const snapshot = await reconcileStudyDay(today)
    expect((await db.dailyLearningSessions.get('daily:old'))?.status).toBe('rolled-over')
    expect(await db.dailyQueueAttempts.get('attempt')).toBeTruthy()
    expect(await db.reviewLogs.where('wordId').equals('w1').count()).toBe(1)
    expect(snapshot?.items.some((item) => item.wordId === 'w1' && item.stage === 'learn')).toBe(true)
  })
})
