import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../db/database'
import type { DailyQueueItem } from '../../types/models'
import {
  aggregateSessionRating,
  answerDailyCard,
  getOrCreateDailySession,
  initialTodayMastery,
  masteryReinsertionGap,
  nextTodayMastery,
} from './dailyQueueService'

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
    expect([0.2, 0.6, 0.8, 0.95].map((value) => initialTodayMastery(value, false))).toEqual([0, 20, 30, 40])
    expect(initialTodayMastery(0.95, true)).toBe(0)
    expect(nextTodayMastery(0, 'hard')).toBe(40)
    expect(nextTodayMastery(40, 'good')).toBe(100)
    expect(nextTodayMastery(80, 'again')).toBe(0)
    expect([0, 40, 80, 100].map(masteryReinsertionGap)).toEqual([2, 4, 7, 0])
    expect(aggregateSessionRating(['hard', 'good'])).toBe('hard')
    expect(aggregateSessionRating(['good', 'again', 'good'])).toBe('again')
  })

  it('distinguishes hard then good from a clean recall in the FSRS log', async () => {
    await seed()
    let snapshot = await answerDailyCard('daily:test', 'i-w1', 'hard', new Date('2026-07-13T08:01:00.000Z'))
    expect(snapshot.current?.todayMastery).toBe(40)
    expect(snapshot.current?.nextGap).toBe(4)
    snapshot = await answerDailyCard('daily:test', snapshot.current!.itemId, 'good', new Date('2026-07-13T08:02:00.000Z'))
    const log = await db.reviewLogs.where('wordId').equals('w1').first()
    expect(log?.rating).toBe('hard')
    expect(log?.sessionAttemptCount).toBe(2)
    expect(log?.todayMasteryAfter).toBe(100)
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

  it('rebuilds an unstarted session after the limit or enabled-list contents change', async () => {
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

    snapshot = await getOrCreateDailySession(undefined, new Date('2026-07-13T08:01:00.000Z'))
    expect(snapshot.totalCards).toBe(1)
    expect(snapshot.session.initialWordIds).toEqual(['w2'])
    expect(snapshot.items.filter((item) => item.status === 'pending')).toHaveLength(1)

    snapshot = await answerDailyCard(sessionId, snapshot.current!.itemId, 'hard', new Date('2026-07-13T08:02:00.000Z'))
    await db.studyListItems.delete('list:w2')
    snapshot = await getOrCreateDailySession(undefined, new Date('2026-07-13T08:03:00.000Z'))
    expect(snapshot.session.sessionId).toBe(sessionId)
    expect(snapshot.attempts).toHaveLength(1)
    expect(snapshot.current?.wordId).toBe('w2')
  })
})
