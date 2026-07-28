import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../db/database'
import { clearWordLearningHistory, removeWordFromWordbook, resetWordForRelearning } from './wordbookService'

describe('wordbook relearning', () => {
  beforeEach(async () => {
    db.close()
    await db.delete()
    await db.open()
  })

  it('preserves scheduling history and adds an idempotent relearn activity', async () => {
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

    expect(await db.wordbook.get('w1')).toEqual(expect.objectContaining({ note: 'keep', tags: ['fruit'], addedAt: old }))
    expect(await db.reviewState.get('w1')).toEqual(expect.objectContaining({ reps: 3, totalReviews: 3, schedulerVersion: 'fsrs-5' }))
    expect(await db.reviewLogs.where('wordId').equals('w1').count()).toBe(1)
    expect(await db.contextAttempts.get('reading:w1')).toBeTruthy()
    expect(await db.studyListItems.get('list:w1')).toEqual(expect.objectContaining({ addedAt: old, learningEnabled: 1 }))
    const items = await db.dailyQueueItems.where('sessionId').equals('daily:2026-07-15').toArray()
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: 'old-item', status: 'completed' }),
      expect.objectContaining({ wordId: 'w1', reason: 'reencounter', stage: 'learn' }),
    ]))
    expect(await db.dailyQueueAttempts.where('wordId').equals('w1').count()).toBe(2)
    expect((await db.dailyLearningSessions.get('daily:2026-07-15'))?.sessionRevision).toBeGreaterThan(0)

    await clearWordLearningHistory('w1', undefined, new Date('2026-07-15T08:05:00.000Z'))

    expect(await db.reviewLogs.where('wordId').equals('w1').count()).toBe(0)
    expect(await db.contextAttempts.where('wordId').equals('w1').count()).toBe(0)
    expect(await db.reviewState.get('w1')).toEqual(expect.objectContaining({
      reps: 0,
      totalReviews: 0,
      schedulerVersion: 'fsrs-5',
    }))
    const freshItems = await db.dailyQueueItems.where('wordId').equals('w1').toArray()
    expect(freshItems).toHaveLength(1)
    expect(freshItems[0]).toEqual(expect.objectContaining({
      reason: 'reencounter',
      stage: 'learn',
      wasNew: true,
      canonicalGradeCommitted: false,
    }))
    const freshAttempts = await db.dailyQueueAttempts.where('wordId').equals('w1').toArray()
    expect(freshAttempts).toHaveLength(1)
    expect(freshAttempts[0]).toEqual(expect.objectContaining({
      evidenceKind: 'manual-relearn',
      committedToFsrs: false,
    }))
  })

  it('removes a deleted word from active units and revises the live session', async () => {
    const now = '2026-07-15T08:00:00.000Z'
    await db.dictionaryEntries.put({
      entryId: 'e1',
      headword: 'apple',
      headwordLower: 'apple',
      posList: ['n'],
      sensesJson: '["苹果"]',
      examplesJson: '[]',
      usageJson: '[]',
    })
    await db.wordbook.put({
      wordId: 'w1',
      entryId: 'e1',
      headword: 'apple',
      headwordLower: 'apple',
      addedAt: now,
      note: '',
      tags: [],
      archived: 0,
    })
    await db.reviewState.put({
      wordId: 'w1',
      cycle: 0,
      nextReviewAt: now,
      successCount: 0,
      lapseCount: 0,
      totalReviews: 0,
    })
    await db.dailyLearningSessions.put({
      sessionId: 'daily:delete',
      dayKey: '2026-07-15',
      status: 'active',
      phase: 'cards',
      engineVersion: 2,
      sessionRevision: 4,
      activeUnitIndex: 0,
      learningStage: 'learn',
      selectedListIds: [],
      initialWordIds: ['w1'],
      unitsJson: JSON.stringify([{
        unitId: 'u1',
        index: 0,
        wordIds: ['w1'],
        dueWordIds: [],
        newWordIds: ['w1'],
        status: 'active',
      }]),
      articleStatus: 'ready',
      createdAt: now,
      updatedAt: now,
    })
    await db.dailyQueueItems.put({
      itemId: 'i1',
      sessionId: 'daily:delete',
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

    await removeWordFromWordbook('w1')

    const session = await db.dailyLearningSessions.get('daily:delete')
    expect(session?.initialWordIds).toEqual([])
    expect(JSON.parse(session?.unitsJson ?? '[]')[0]).toMatchObject({
      wordIds: [],
      newWordIds: [],
    })
    expect(session?.sessionRevision).toBe(5)
    expect(session?.articleStatus).toBe('stale')
    expect(await db.dailyQueueItems.where('wordId').equals('w1').count()).toBe(0)
  })
})
