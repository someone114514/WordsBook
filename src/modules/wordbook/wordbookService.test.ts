import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../db/database'
import { resetWordForRelearning } from './wordbookService'

describe('wordbook relearning', () => {
  beforeEach(async () => {
    db.close()
    await db.delete()
    await db.open()
  })

  it('resets scheduling evidence and reinserts an existing word without losing metadata', async () => {
    const old = '2026-07-14T00:00:00.000Z'
    const now = new Date('2026-07-15T08:00:00.000Z')
    await db.dictionaryEntries.put({ entryId: 'e1', headword: 'apple', headwordLower: 'apple', posList: ['n'], sensesJson: '["苹果"]', examplesJson: '[]', usageJson: '[]' })
    await db.wordbook.put({ wordId: 'w1', entryId: 'e1', headword: 'apple', headwordLower: 'apple', addedAt: old, note: 'keep', tags: ['fruit'], archived: 0 })
    await db.studyLists.put({ listId: 'list', name: '学习', description: '', studyEnabled: 1, createdAt: old, updatedAt: old })
    await db.studyListItems.put({ membershipId: 'list:w1', listId: 'list', wordId: 'w1', source: 'lookup', learningEnabled: 1, autoActivate: 0, addedAt: old })
    await db.reviewState.put({ wordId: 'w1', cycle: 0, nextReviewAt: old, successCount: 2, lapseCount: 1, totalReviews: 3, reps: 3, schedulerVersion: 'fsrs-5' })
    await db.reviewLogs.add({ wordId: 'w1', reviewedAt: old, rating: 'good', cycleBefore: 0, cycleAfter: 0, nextReviewAtBefore: old, nextReviewAtAfter: old })
    await db.dailyLearningSessions.put({ sessionId: 'daily:2026-07-15', dayKey: '2026-07-15', status: 'active', phase: 'cards', selectedListIds: ['list'], initialWordIds: ['w1'], articleStatus: 'waiting', createdAt: old, updatedAt: old })
    await db.dailyQueueItems.put({ itemId: 'old-item', sessionId: 'daily:2026-07-15', kind: 'card', wordId: 'w1', reason: 'initial', position: 0, status: 'completed', attemptNo: 1, maxAttempts: 5, retrievability: 0.8, todayMastery: 100, createdAt: old, updatedAt: old })
    await db.dailyQueueAttempts.put({ attemptId: 'old-attempt', sessionId: 'daily:2026-07-15', itemId: 'old-item', wordId: 'w1', rating: 'good', committedToFsrs: true, answeredAt: old })
    await db.contextAttempts.put({ attemptId: 'reading:w1', sessionId: 'reading', wordId: 'w1', result: 'correct', answeredAt: old })

    await resetWordForRelearning('w1', undefined, now)

    expect(await db.wordbook.get('w1')).toEqual(expect.objectContaining({ note: 'keep', tags: ['fruit'], addedAt: now.toISOString() }))
    expect(await db.reviewState.get('w1')).toEqual(expect.objectContaining({ reps: 0, totalReviews: 0, schedulerVersion: 'fsrs-5' }))
    expect(await db.reviewLogs.where('wordId').equals('w1').count()).toBe(0)
    expect(await db.contextAttempts.get('reading:w1')).toBeTruthy()
    expect(await db.studyListItems.get('list:w1')).toEqual(expect.objectContaining({ addedAt: now.toISOString(), learningEnabled: 1 }))
    const items = await db.dailyQueueItems.where('sessionId').equals('daily:2026-07-15').toArray()
    expect(items).toEqual([expect.objectContaining({ wordId: 'w1', reason: 'reencounter', todayMastery: 0, recallStreak: 0 })])
    expect(await db.dailyQueueAttempts.where('wordId').equals('w1').count()).toBe(0)
  })
})
