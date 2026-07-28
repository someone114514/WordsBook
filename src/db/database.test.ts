import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { db } from './database'
import type { LearningUnit } from '../types/models'

const legacyV8Stores = {
  dictionaryMeta: '&id, version, installedAt',
  dictionaryEntries: '&entryId, headwordLower',
  dictionaryIndex: '&token',
  wordbook: '&wordId, &entryId, headwordLower, addedAt, archived, integrityStatus',
  reviewState: '&wordId, nextReviewAt, cycle, totalReviews, suspendedAt',
  reviewLogs: '++id, wordId, reviewedAt, rating, source, [wordId+reviewedAt]',
  settings: '&key',
  aiOverrides: '&entryId, mode, createdAt',
  aiOverrideHistory: '++id, entryId, createdAt',
  syncMeta: '&key',
  syncRecords: '&key, entity, recordId, updatedAt, deletedAt',
  syncTombstones: '&key, entity, recordId, deletedAt',
  studyLists: '&listId, studyEnabled, systemType, updatedAt',
  studyListItems: '&membershipId, listId, wordId, learningEnabled, [listId+wordId]',
  readingSessions: '&sessionId, dayKey, status, updatedAt',
  contextAttempts: '&attemptId, sessionId, wordId, answeredAt',
  localSecrets: '&key',
  dailyLearningSessions: '&sessionId, dayKey, status, updatedAt',
  dailyQueueItems: '&itemId, sessionId, status, position, wordId, [sessionId+status+position]',
  dailyQueueAttempts: '&attemptId, sessionId, wordId, answeredAt, [sessionId+wordId]',
}

describe('database v9 migration', () => {
  afterEach(async () => {
    db.close()
    await db.delete()
  })

  it('turns a malformed v8 session into a recoverable v2 unit without deleting long-term evidence', async () => {
    db.close()
    await db.delete()
    const legacy = new Dexie('wordsbook-db')
    legacy.version(8).stores(legacyV8Stores)
    await legacy.open()
    const now = '2026-07-13T08:00:00.000Z'
    await legacy.table('dailyLearningSessions').put({
      sessionId: 'legacy:broken',
      dayKey: '2026-07-13',
      status: 'active',
      phase: 'cards',
      selectedListIds: [],
      initialWordIds: ['missing-item', 'recover-me'],
      activeRoundIndex: 1,
      articleStatus: 'waiting',
      createdAt: now,
      updatedAt: now,
    })
    await legacy.table('dailyQueueItems').bulkPut([
      {
        itemId: 'legacy:done',
        sessionId: 'legacy:broken',
        kind: 'card',
        wordId: 'recover-me',
        reason: 'initial',
        roundIndex: 1,
        position: 0,
        status: 'completed',
        attemptNo: 1,
        maxAttempts: 2,
        retrievability: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        itemId: 'legacy:retry',
        sessionId: 'legacy:broken',
        kind: 'card',
        wordId: 'recover-me',
        reason: 'again-repeat',
        roundIndex: 3,
        position: 1,
        status: 'pending',
        attemptNo: 2,
        maxAttempts: 2,
        retrievability: 0,
        createdAt: now,
        updatedAt: now,
      },
    ])
    await legacy.table('reviewState').put({
      wordId: 'recover-me',
      cycle: 3,
      nextReviewAt: now,
      successCount: 4,
      lapseCount: 1,
      totalReviews: 5,
    })
    await legacy.table('reviewLogs').put({
      wordId: 'recover-me',
      rating: 'again',
      source: 'daily-session',
      reviewedAt: now,
      scheduledDays: 2,
      elapsedDays: 2,
      stateBefore: 'review',
      stateAfter: 'relearning',
    })
    legacy.close()

    await db.open()
    const migrated = await db.dailyLearningSessions.get('legacy:broken')
    const units = JSON.parse(migrated?.unitsJson ?? '[]') as LearningUnit[]
    const retry = await db.dailyQueueItems.get('legacy:retry')

    expect(migrated).toMatchObject({
      engineVersion: 2,
      status: 'active',
      phase: 'cards',
      learningStage: 'probe',
      recoveryMode: true,
      recoveryBacklogCount: 1,
      initialWordIds: ['recover-me'],
      activeUnitIndex: 0,
    })
    expect(units).toHaveLength(1)
    expect(units[0]).toMatchObject({
      index: 0,
      wordIds: ['recover-me'],
      status: 'active',
    })
    expect(retry).toMatchObject({
      unitId: 'legacy:broken:unit:1',
      stage: 'retry',
      status: 'pending',
    })
    expect(await db.reviewState.get('recover-me')).toMatchObject({ cycle: 3, totalReviews: 5 })
    expect(await db.reviewLogs.where('wordId').equals('recover-me').count()).toBe(1)
  })
})
