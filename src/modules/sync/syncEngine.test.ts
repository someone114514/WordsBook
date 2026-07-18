/// <reference types="node" />

import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../db/database'
import { importUserData } from '../settings/backupService'
import {
  collectLocalSyncDataset,
  markPayloadChanged,
  markRecordDeleted,
} from './localSyncStore'
import { runCloudSync } from './syncEngine'
import type { CloudSyncRemote, SyncDataset, SyncDeletedRecord, SyncRecord } from './syncTypes'

class FakeRemote implements CloudSyncRemote {
  private records = new Map<string, SyncRecord>()
  private tombstones = new Map<string, SyncDeletedRecord>()

  public constructor(seed: SyncDataset = { records: [], tombstones: [] }) {
    for (const record of seed.records) {
      this.records.set(this.key(record.entity, record.recordId), structuredClone(record))
    }
    for (const tombstone of seed.tombstones) {
      this.tombstones.set(this.key(tombstone.entity, tombstone.recordId), structuredClone(tombstone))
    }
  }

  async fetchAll(): Promise<SyncDataset> {
    return {
      records: structuredClone([...this.records.values()]),
      tombstones: structuredClone([...this.tombstones.values()]),
    }
  }

  async upsert(records: SyncRecord[]): Promise<void> {
    for (const record of records) {
      const key = this.key(record.entity, record.recordId)
      this.records.set(key, structuredClone(record))
      this.tombstones.delete(key)
    }
  }

  async delete(records: SyncDeletedRecord[]): Promise<void> {
    for (const record of records) {
      const key = this.key(record.entity, record.recordId)
      this.records.delete(key)
      this.tombstones.set(key, structuredClone(record))
    }
  }

  private key(entity: string, recordId: string): string {
    return `${entity}:${recordId}`
  }
}

async function resetDb(): Promise<void> {
  await db.delete()
  await db.open()
}

function loadBackupFile(): Blob {
  const raw = readFileSync(resolve('backup/wordsbook-backup-2026-06-08.json'), 'utf8')
  return new Blob([raw], { type: 'application/json' })
}

describe('cloud sync engine', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('imports the current backup sample and exposes it as syncable local data', async () => {
    const report = await importUserData(loadBackupFile())
    const dataset = await collectLocalSyncDataset()

    expect(report.importedWordbook).toBe(536)
    expect(report.importedReviewState).toBe(536)
    expect(report.importedReviewLogs).toBe(3372)
    expect(report.importedSettings).toBe(8)
    expect(dataset.records.filter((row) => row.entity === 'wordbook')).toHaveLength(536)
    expect(dataset.records.filter((row) => row.entity === 'reviewState')).toHaveLength(536)
    expect(dataset.records.filter((row) => row.entity === 'reviewLogs')).toHaveLength(3372)
    expect(dataset.records.filter((row) => row.entity === 'settings')).toHaveLength(7)
  })

  it('uploads the backup sample and restores it into an empty local database', async () => {
    await importUserData(loadBackupFile())
    const remote = new FakeRemote()

    const upload = await runCloudSync(remote, 'upload')
    expect(upload.pushed).toBeGreaterThan(4000)

    await resetDb()
    const download = await runCloudSync(remote, 'download')

    expect(download.pulled).toBeGreaterThan(4000)
    expect(await db.wordbook.count()).toBe(536)
    expect(await db.reviewState.count()).toBe(536)
    expect(await db.reviewLogs.count()).toBe(3372)
    expect(await db.settings.count()).toBe(7)
  }, 20_000)

  it('merges local and remote wordbook additions in both directions', async () => {
    const now = '2026-06-08T00:00:00.000Z'
    const localItem = {
      wordId: 'local-word',
      entryId: 'entry-local',
      addedAt: now,
      note: '',
      tags: [],
      archived: 0 as const,
    }
    const remoteItem = {
      wordId: 'remote-word',
      entryId: 'entry-remote',
      addedAt: now,
      note: '',
      tags: [],
      archived: 0 as const,
    }

    await db.wordbook.put(localItem)
    await markPayloadChanged('wordbook', localItem, now)
    const remote = new FakeRemote({
      records: [
        {
          entity: 'wordbook',
          recordId: remoteItem.wordId,
          payload: remoteItem,
          updatedAt: now,
          sourceClientId: 'remote',
        },
      ],
      tombstones: [],
    })

    await runCloudSync(remote, 'bidirectional')
    const cloud = await remote.fetchAll()

    expect(await db.wordbook.get('remote-word')).toMatchObject(remoteItem)
    expect(cloud.records.some((row) => row.entity === 'wordbook' && row.recordId === 'local-word')).toBe(true)
  })

  it('keeps the more advanced review state during conflict resolution', async () => {
    const localState = {
      wordId: 'word-a',
      cycle: 3,
      nextReviewAt: '2026-06-12T00:00:00.000Z',
      lastReviewedAt: '2026-06-08T00:00:00.000Z',
      successCount: 3,
      lapseCount: 0,
      totalReviews: 3,
    }
    const remoteState = {
      ...localState,
      cycle: 1,
      nextReviewAt: '2026-06-10T00:00:00.000Z',
      lastReviewedAt: '2026-06-09T00:00:00.000Z',
      successCount: 1,
      totalReviews: 1,
    }

    await db.reviewState.put(localState)
    await markPayloadChanged('reviewState', localState, localState.lastReviewedAt)
    const remote = new FakeRemote({
      records: [
        {
          entity: 'reviewState',
          recordId: 'word-a',
          payload: remoteState,
          updatedAt: remoteState.lastReviewedAt,
          sourceClientId: 'remote',
        },
      ],
      tombstones: [],
    })

    await runCloudSync(remote, 'bidirectional')
    const cloud = await remote.fetchAll()
    const syncedState = cloud.records.find((row) => row.entity === 'reviewState' && row.recordId === 'word-a')

    expect(syncedState?.payload).toMatchObject({ totalReviews: 3, cycle: 3 })
  })

  it('syncs tombstones so deleted words are not resurrected', async () => {
    const deletedAt = '2026-06-08T00:10:00.000Z'
    const oldItem = {
      wordId: 'bad-word',
      entryId: 'entry-bad',
      addedAt: '2026-06-07T00:00:00.000Z',
      note: '',
      tags: [],
      archived: 0 as const,
    }
    const remote = new FakeRemote({
      records: [
        {
          entity: 'wordbook',
          recordId: oldItem.wordId,
          payload: oldItem,
          updatedAt: oldItem.addedAt,
          sourceClientId: 'remote',
        },
      ],
      tombstones: [],
    })

    await markRecordDeleted('wordbook', oldItem.wordId, deletedAt)
    await runCloudSync(remote, 'bidirectional')
    const cloud = await remote.fetchAll()

    expect(await db.wordbook.get(oldItem.wordId)).toBeUndefined()
    expect(cloud.records.some((row) => row.recordId === oldItem.wordId)).toBe(false)
    expect(cloud.tombstones.some((row) => row.recordId === oldItem.wordId)).toBe(true)
  })
})
