import { db } from '../../db/database'
import type { ReviewState, SyncEntity } from '../../types/models'
import {
  applyRemoteDeletions,
  applyRemoteRecords,
  collectLocalSyncDataset,
  compareIso,
  getBlockedCloudSettingKeys,
  syncRecordKey,
} from './localSyncStore'
import type {
  CloudSyncMode,
  CloudSyncRemote,
  SyncDataset,
  SyncDeletedRecord,
  SyncPreview,
  SyncRecord,
  SyncResult,
} from './syncTypes'

const LAST_SYNC_KEY = 'lastSuccessfulSyncAt'

function recordMap(records: SyncRecord[]): Map<string, SyncRecord> {
  return new Map(records.map((record) => [syncRecordKey(record.entity, record.recordId), record]))
}

function tombstoneMap(records: SyncDeletedRecord[]): Map<string, SyncDeletedRecord> {
  return new Map(records.map((record) => [syncRecordKey(record.entity, record.recordId), record]))
}

function isPayloadEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function isTombstoneNewer(
  tombstone: SyncDeletedRecord | undefined,
  record: SyncRecord | undefined,
): boolean {
  if (!tombstone || !record) {
    return Boolean(tombstone)
  }

  return compareIso(tombstone.deletedAt, record.updatedAt) >= 0
}

function reviewStateRank(state: ReviewState, updatedAt: string): string {
  return [
    String(state.reps ?? state.totalReviews).padStart(8, '0'),
    state.lastReviewedAt ?? '',
    updatedAt,
  ].join('|')
}

function chooseWinner(
  local: SyncRecord,
  remote: SyncRecord,
): { winner: 'local' | 'remote'; conflict: boolean } {
  if (isPayloadEqual(local.payload, remote.payload)) {
    return { winner: compareIso(local.updatedAt, remote.updatedAt) >= 0 ? 'local' : 'remote', conflict: false }
  }

  if (local.entity === 'reviewState' && remote.entity === 'reviewState') {
    const localRank = reviewStateRank(local.payload as ReviewState, local.updatedAt)
    const remoteRank = reviewStateRank(remote.payload as ReviewState, remote.updatedAt)
    return { winner: localRank >= remoteRank ? 'local' : 'remote', conflict: true }
  }

  return { winner: compareIso(local.updatedAt, remote.updatedAt) >= 0 ? 'local' : 'remote', conflict: true }
}

function allKeys(...maps: Array<Map<string, unknown>>): Set<string> {
  const keys = new Set<string>()
  for (const map of maps) {
    for (const key of map.keys()) {
      keys.add(key)
    }
  }
  return keys
}

function shouldHandleEntity(mode: CloudSyncMode, direction: 'upload' | 'download'): boolean {
  return mode === 'bidirectional' || mode === direction
}

export async function previewCloudSync(
  remote: CloudSyncRemote,
  mode: CloudSyncMode = 'bidirectional',
): Promise<SyncPreview> {
  const [local, cloud, blockedSettings] = await Promise.all([
    collectLocalSyncDataset(),
    remote.fetchAll(),
    getBlockedCloudSettingKeys(),
  ])
  return buildSyncPreview(local, cloud, mode, blockedSettings)
}

export function buildSyncPreview(
  local: SyncDataset,
  cloud: SyncDataset,
  mode: CloudSyncMode,
  blockedSettings: string[] = [],
): SyncPreview {
  const localRecords = recordMap(local.records)
  const cloudRecords = recordMap(cloud.records)
  const localTombstones = tombstoneMap(local.tombstones)
  const cloudTombstones = tombstoneMap(cloud.tombstones)
  const preview: SyncPreview = {
    upload: 0,
    download: 0,
    conflicts: 0,
    deletions: 0,
    blockedSettings,
  }

  for (const key of allKeys(localRecords, cloudRecords, localTombstones, cloudTombstones)) {
    const localRecord = localRecords.get(key)
    const cloudRecord = cloudRecords.get(key)
    const localTombstone = localTombstones.get(key)
    const cloudTombstone = cloudTombstones.get(key)

    if (isTombstoneNewer(localTombstone, cloudRecord)) {
      if (shouldHandleEntity(mode, 'upload')) {
        preview.upload += 1
        preview.deletions += 1
      }
      continue
    }

    if (isTombstoneNewer(cloudTombstone, localRecord)) {
      if (shouldHandleEntity(mode, 'download')) {
        preview.download += 1
        preview.deletions += 1
      }
      continue
    }

    if (localRecord && !cloudRecord && shouldHandleEntity(mode, 'upload')) {
      preview.upload += 1
      continue
    }

    if (!localRecord && cloudRecord && shouldHandleEntity(mode, 'download')) {
      preview.download += 1
      continue
    }

    if (localRecord && cloudRecord && !isPayloadEqual(localRecord.payload, cloudRecord.payload)) {
      preview.conflicts += 1
      const winner = chooseWinner(localRecord, cloudRecord).winner
      if (winner === 'local' && shouldHandleEntity(mode, 'upload')) {
        preview.upload += 1
      }
      if (winner === 'remote' && shouldHandleEntity(mode, 'download')) {
        preview.download += 1
      }
      continue
    }

    if (localRecord && cloudRecord) {
      if (compareIso(localRecord.updatedAt, cloudRecord.updatedAt) > 0 && shouldHandleEntity(mode, 'upload')) {
        preview.upload += 1
      } else if (compareIso(cloudRecord.updatedAt, localRecord.updatedAt) > 0 && shouldHandleEntity(mode, 'download')) {
        preview.download += 1
      }
    }
  }

  return preview
}

function isEntity(key: string, entity: SyncEntity): boolean {
  return key.startsWith(`${entity}:`)
}

async function writeLastSync(completedAt: string): Promise<void> {
  await db.syncMeta.put({ key: LAST_SYNC_KEY, value: completedAt })
}

export async function getLastSuccessfulSyncAt(): Promise<string | null> {
  const row = await db.syncMeta.get(LAST_SYNC_KEY)
  return typeof row?.value === 'string' ? row.value : null
}

export async function runCloudSync(
  remote: CloudSyncRemote,
  mode: CloudSyncMode = 'bidirectional',
): Promise<SyncResult> {
  const local = await collectLocalSyncDataset()
  const cloud = await remote.fetchAll()
  const blockedSettings = await getBlockedCloudSettingKeys()
  const preview = buildSyncPreview(local, cloud, mode, blockedSettings)
  const localRecords = recordMap(local.records)
  const cloudRecords = recordMap(cloud.records)
  const localTombstones = tombstoneMap(local.tombstones)
  const cloudTombstones = tombstoneMap(cloud.tombstones)
  const recordsToPush: SyncRecord[] = []
  const tombstonesToPush: SyncDeletedRecord[] = []
  const recordsToPull: SyncRecord[] = []
  const tombstonesToApply: SyncDeletedRecord[] = []
  let pulled = 0
  let deleted = 0

  for (const key of allKeys(localRecords, cloudRecords, localTombstones, cloudTombstones)) {
    const localRecord = localRecords.get(key)
    const cloudRecord = cloudRecords.get(key)
    const localTombstone = localTombstones.get(key)
    const cloudTombstone = cloudTombstones.get(key)

    if (isTombstoneNewer(localTombstone, cloudRecord)) {
      if (shouldHandleEntity(mode, 'upload') && localTombstone) {
        tombstonesToPush.push(localTombstone)
      }
      continue
    }

    if (isTombstoneNewer(cloudTombstone, localRecord)) {
      if (shouldHandleEntity(mode, 'download') && cloudTombstone) {
        tombstonesToApply.push(cloudTombstone)
        pulled += 1
        deleted += 1
      }
      continue
    }

    if (localRecord && !cloudRecord) {
      if (shouldHandleEntity(mode, 'upload')) {
        recordsToPush.push(localRecord)
      }
      continue
    }

    if (!localRecord && cloudRecord) {
      if (shouldHandleEntity(mode, 'download')) {
        recordsToPull.push(cloudRecord)
        pulled += 1
      }
      continue
    }

    if (!localRecord || !cloudRecord) {
      continue
    }

    const { winner } = chooseWinner(localRecord, cloudRecord)
    if (winner === 'local' && shouldHandleEntity(mode, 'upload')) {
      if (!isPayloadEqual(localRecord.payload, cloudRecord.payload) || compareIso(localRecord.updatedAt, cloudRecord.updatedAt) > 0) {
        recordsToPush.push(localRecord)
      }
    }

    if (winner === 'remote' && shouldHandleEntity(mode, 'download')) {
      if (!isPayloadEqual(localRecord.payload, cloudRecord.payload) || compareIso(cloudRecord.updatedAt, localRecord.updatedAt) > 0) {
        recordsToPull.push(cloudRecord)
        pulled += 1
      }
    }
  }

  if (recordsToPull.length > 0) {
    await applyRemoteRecords(recordsToPull)
  }
  if (tombstonesToApply.length > 0) {
    await applyRemoteDeletions(tombstonesToApply)
  }
  if (recordsToPush.length > 0) {
    await remote.upsert(recordsToPush)
  }
  if (tombstonesToPush.length > 0) {
    await remote.delete(tombstonesToPush)
  }

  const completedAt = new Date().toISOString()
  await writeLastSync(completedAt)

  return {
    ...preview,
    pushed: recordsToPush.length + tombstonesToPush.length,
    pulled,
    deleted,
    completedAt,
  }
}

export function summarizeDataset(dataset: SyncDataset): Record<SyncEntity, number> {
  return {
    dictionaryEntries: dataset.records.filter((row) => isEntity(syncRecordKey(row.entity, row.recordId), 'dictionaryEntries')).length,
    wordbook: dataset.records.filter((row) => row.entity === 'wordbook').length,
    reviewState: dataset.records.filter((row) => row.entity === 'reviewState').length,
    reviewLogs: dataset.records.filter((row) => row.entity === 'reviewLogs').length,
    settings: dataset.records.filter((row) => row.entity === 'settings').length,
    aiOverrides: dataset.records.filter((row) => row.entity === 'aiOverrides').length,
    aiOverrideHistory: dataset.records.filter((row) => row.entity === 'aiOverrideHistory').length,
    studyLists: dataset.records.filter((row) => row.entity === 'studyLists').length,
    studyListItems: dataset.records.filter((row) => row.entity === 'studyListItems').length,
    readingSessions: dataset.records.filter((row) => row.entity === 'readingSessions').length,
    contextAttempts: dataset.records.filter((row) => row.entity === 'contextAttempts').length,
    dailyLearningSessions: dataset.records.filter((row) => row.entity === 'dailyLearningSessions').length,
    dailyQueueItems: dataset.records.filter((row) => row.entity === 'dailyQueueItems').length,
    dailyQueueAttempts: dataset.records.filter((row) => row.entity === 'dailyQueueAttempts').length,
  }
}
