import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../db/database'
import { importUserData } from './backupService'

describe('backup import migration', () => {
  beforeEach(async () => {
    db.close()
    await db.delete()
    await db.open()
  })

  it('normalizes a legacy active session into a recoverable v2 unit', async () => {
    const now = '2026-07-13T08:00:00.000Z'
    const backup = {
      schemaVersion: 5,
      exportedAt: now,
      dictionaryEntries: [{
        entryId: 'e1',
        headword: 'resilient',
        headwordLower: 'resilient',
        posList: ['adj'],
        sensesJson: '["有韧性的"]',
        examplesJson: '[]',
        usageJson: '[]',
      }],
      wordbook: [{
        wordId: 'w1',
        entryId: 'e1',
        headword: 'resilient',
        headwordLower: 'resilient',
        addedAt: now,
        note: '',
        tags: [],
        archived: 0,
      }],
      reviewState: [{
        wordId: 'w1',
        cycle: 2,
        nextReviewAt: now,
        successCount: 3,
        lapseCount: 1,
        totalReviews: 4,
      }],
      reviewLogs: [],
      settings: [{ key: 'roundWordCount', value: 10 }],
      dailyLearningSessions: [{
        sessionId: 'legacy:backup',
        dayKey: '2026-07-13',
        status: 'active',
        phase: 'cards',
        selectedListIds: [],
        initialWordIds: ['missing', 'w1'],
        articleStatus: 'waiting',
        createdAt: now,
        updatedAt: now,
      }],
      dailyQueueItems: [{
        itemId: 'legacy:retry',
        sessionId: 'legacy:backup',
        kind: 'card',
        wordId: 'w1',
        reason: 'again-repeat',
        position: 1,
        status: 'pending',
        attemptNo: 2,
        maxAttempts: 3,
        retrievability: 0.2,
        createdAt: now,
        updatedAt: now,
      }],
      dailyQueueAttempts: [{
        attemptId: 'legacy:answer',
        sessionId: 'legacy:backup',
        itemId: 'legacy:old',
        wordId: 'w1',
        rating: 'again',
        committedToFsrs: true,
        answeredAt: now,
      }],
    }

    await importUserData(new Blob([JSON.stringify(backup)], { type: 'application/json' }))

    const session = await db.dailyLearningSessions.get('legacy:backup')
    const units = JSON.parse(session?.unitsJson ?? '[]')
    expect(session).toMatchObject({
      engineVersion: 2,
      recoveryMode: true,
      initialWordIds: ['w1'],
      activeUnitIndex: 0,
      activityOrdinal: 1,
    })
    expect(units).toEqual([expect.objectContaining({
      unitId: 'legacy:backup:unit:1',
      wordIds: ['w1'],
      status: 'active',
    })])
    expect(await db.dailyQueueItems.get('legacy:retry')).toMatchObject({
      unitId: 'legacy:backup:unit:1',
      stage: 'retry',
      canonicalGradeCommitted: true,
    })
    expect(await db.reviewState.get('w1')).toMatchObject({ cycle: 2, totalReviews: 4 })
  })

  it('rejects an unknown future backup schema instead of silently importing it', async () => {
    const future = {
      schemaVersion: 7,
      exportedAt: new Date().toISOString(),
      wordbook: [],
      reviewState: [],
      reviewLogs: [],
      settings: [],
    }
    await expect(importUserData(new Blob([JSON.stringify(future)])))
      .rejects.toThrow('Invalid backup file format')
  })
})
