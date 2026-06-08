import { db } from '../../db/database'
import type {
  AiOverrideHistoryRecord,
  ReviewLog,
  SettingItem,
  SyncEntity,
  SyncTombstone,
} from '../../types/models'
import type {
  SyncDataset,
  SyncDeletedRecord,
  SyncPayload,
  SyncPayloadByEntity,
  SyncRecord,
} from './syncTypes'

const CLIENT_ID_KEY = 'clientId'
const SENSITIVE_SETTING_KEYS = new Set(['deepseekApiKey'])
const LOCAL_DICTIONARY_IDS = new Set(['ai-local'])
const EPOCH = '1970-01-01T00:00:00.000Z'

export function syncRecordKey(entity: SyncEntity, recordId: string): string {
  return `${entity}:${recordId}`
}

function isLocalUserDictionaryEntry(entry: { entryId: string; dictionaryId?: string }): boolean {
  return LOCAL_DICTIONARY_IDS.has(entry.dictionaryId ?? '') || entry.entryId.startsWith('ai:')
}

export function reviewLogSyncId(log: ReviewLog): string {
  return [
    log.wordId,
    log.reviewedAt,
    log.rating,
    log.cycleBefore,
    log.cycleAfter,
    log.nextReviewAtBefore,
    log.nextReviewAtAfter,
  ].join('|')
}

export function aiOverrideHistorySyncId(row: AiOverrideHistoryRecord): string {
  return [row.entryId, row.createdAt, row.id ?? 'local'].join('|')
}

export function getPayloadRecordId(entity: SyncEntity, payload: SyncPayload): string {
  switch (entity) {
    case 'dictionaryEntries':
      return (payload as SyncPayloadByEntity['dictionaryEntries']).entryId
    case 'wordbook':
      return (payload as SyncPayloadByEntity['wordbook']).wordId
    case 'reviewState':
      return (payload as SyncPayloadByEntity['reviewState']).wordId
    case 'reviewLogs':
      return reviewLogSyncId(payload as SyncPayloadByEntity['reviewLogs'])
    case 'settings':
      return (payload as SyncPayloadByEntity['settings']).key
    case 'aiOverrides':
      return (payload as SyncPayloadByEntity['aiOverrides']).entryId
    case 'aiOverrideHistory':
      return aiOverrideHistorySyncId(payload as SyncPayloadByEntity['aiOverrideHistory'])
  }
}

function getPayloadTimestamp(entity: SyncEntity, payload: SyncPayload): string {
  switch (entity) {
    case 'dictionaryEntries':
      return (payload as SyncPayloadByEntity['dictionaryEntries']).aiUpdatedAt ?? EPOCH
    case 'wordbook':
      return (payload as SyncPayloadByEntity['wordbook']).addedAt
    case 'reviewState':
      return (
        (payload as SyncPayloadByEntity['reviewState']).lastReviewedAt ??
        (payload as SyncPayloadByEntity['reviewState']).nextReviewAt
      )
    case 'reviewLogs':
      return (payload as SyncPayloadByEntity['reviewLogs']).reviewedAt
    case 'settings':
      return EPOCH
    case 'aiOverrides':
      return (payload as SyncPayloadByEntity['aiOverrides']).createdAt
    case 'aiOverrideHistory':
      return (payload as SyncPayloadByEntity['aiOverrideHistory']).createdAt
  }
}

function clonePayload<T>(payload: T): T {
  return JSON.parse(JSON.stringify(payload)) as T
}

export async function getClientId(): Promise<string> {
  const existing = await db.syncMeta.get(CLIENT_ID_KEY)
  if (typeof existing?.value === 'string' && existing.value.length > 0) {
    return existing.value
  }

  const clientId = crypto.randomUUID()
  await db.syncMeta.put({ key: CLIENT_ID_KEY, value: clientId })
  return clientId
}

export async function markRecordChanged(
  entity: SyncEntity,
  recordId: string,
  updatedAt = new Date().toISOString(),
): Promise<void> {
  await db.syncRecords.put({
    key: syncRecordKey(entity, recordId),
    entity,
    recordId,
    updatedAt,
    sourceClientId: await getClientId(),
  })
  await db.syncTombstones.delete(syncRecordKey(entity, recordId))
}

export async function markPayloadChanged(
  entity: SyncEntity,
  payload: SyncPayload,
  updatedAt = new Date().toISOString(),
): Promise<void> {
  await markRecordChanged(entity, getPayloadRecordId(entity, payload), updatedAt)
}

export async function markRecordDeleted(
  entity: SyncEntity,
  recordId: string,
  deletedAt = new Date().toISOString(),
): Promise<void> {
  const sourceClientId = await getClientId()
  const key = syncRecordKey(entity, recordId)
  await db.syncTombstones.put({ key, entity, recordId, deletedAt, sourceClientId })
  await db.syncRecords.delete(key)
}

async function collectRecord<E extends SyncEntity>(
  entity: E,
  payload: SyncPayload,
  sourceClientId: string,
  metaMap: Map<string, { updatedAt: string; sourceClientId?: string }>,
): Promise<SyncRecord<E>> {
  const recordId = getPayloadRecordId(entity, payload)
  const meta = metaMap.get(syncRecordKey(entity, recordId))
  return {
    entity,
    recordId,
    payload: clonePayload(payload),
    updatedAt: meta?.updatedAt ?? getPayloadTimestamp(entity, payload),
    sourceClientId: meta?.sourceClientId ?? sourceClientId,
  } as SyncRecord<E>
}

export async function getBlockedCloudSettingKeys(): Promise<string[]> {
  const rows = await db.settings.toArray()
  return rows
    .map((row) => row.key)
    .filter((key) => SENSITIVE_SETTING_KEYS.has(key))
    .sort()
}

export async function collectLocalSyncDataset(): Promise<SyncDataset> {
  const sourceClientId = await getClientId()
  const metaRows = await db.syncRecords.toArray()
  const metaMap = new Map(metaRows.map((row) => [row.key, row]))
  const records: SyncRecord[] = []

  const dictionaryEntries = await db.dictionaryEntries.filter(isLocalUserDictionaryEntry).toArray()
  for (const entry of dictionaryEntries) {
    records.push(await collectRecord('dictionaryEntries', entry, sourceClientId, metaMap))
  }

  for (const item of await db.wordbook.toArray()) {
    records.push(await collectRecord('wordbook', item, sourceClientId, metaMap))
  }

  for (const state of await db.reviewState.toArray()) {
    records.push(await collectRecord('reviewState', state, sourceClientId, metaMap))
  }

  for (const log of await db.reviewLogs.toArray()) {
    records.push(await collectRecord('reviewLogs', log, sourceClientId, metaMap))
  }

  const settings = (await db.settings.toArray()).filter((row) => !SENSITIVE_SETTING_KEYS.has(row.key))
  for (const setting of settings) {
    records.push(await collectRecord('settings', setting, sourceClientId, metaMap))
  }

  for (const override of await db.aiOverrides.toArray()) {
    records.push(await collectRecord('aiOverrides', override, sourceClientId, metaMap))
  }

  for (const history of await db.aiOverrideHistory.toArray()) {
    records.push(await collectRecord('aiOverrideHistory', history, sourceClientId, metaMap))
  }

  const tombstones = (await db.syncTombstones.toArray()).map((row) => ({
    entity: row.entity,
    recordId: row.recordId,
    deletedAt: row.deletedAt,
    sourceClientId: row.sourceClientId ?? sourceClientId,
  }))

  return { records, tombstones }
}

async function putReviewLog(payload: ReviewLog, updatedAt: string, sourceClientId: string): Promise<void> {
  const incomingId = reviewLogSyncId(payload)
  const candidates = await db.reviewLogs
    .where('[wordId+reviewedAt]')
    .equals([payload.wordId, payload.reviewedAt])
    .toArray()
  const existing = candidates.find((row) => reviewLogSyncId(row) === incomingId)
  if (existing) {
    await db.reviewLogs.put({ ...payload, id: existing.id })
  } else {
    const { id: _id, ...withoutId } = payload
    await db.reviewLogs.add(withoutId)
  }
  await markRecordChanged('reviewLogs', incomingId, updatedAt)
  await db.syncRecords.update(syncRecordKey('reviewLogs', incomingId), { sourceClientId })
}

async function putAiOverrideHistory(
  payload: AiOverrideHistoryRecord,
  updatedAt: string,
  sourceClientId: string,
): Promise<void> {
  const incomingId = aiOverrideHistorySyncId(payload)
  const existing = (await db.aiOverrideHistory.toArray()).find((row) => aiOverrideHistorySyncId(row) === incomingId)
  if (existing) {
    await db.aiOverrideHistory.put({ ...payload, id: existing.id })
  } else {
    const { id: _id, ...withoutId } = payload
    await db.aiOverrideHistory.add(withoutId)
  }
  await markRecordChanged('aiOverrideHistory', incomingId, updatedAt)
  await db.syncRecords.update(syncRecordKey('aiOverrideHistory', incomingId), { sourceClientId })
}

export async function applyRemoteRecord(record: SyncRecord): Promise<void> {
  if (record.entity === 'settings' && SENSITIVE_SETTING_KEYS.has((record.payload as SettingItem).key)) {
    return
  }

  switch (record.entity) {
    case 'dictionaryEntries':
      await db.dictionaryEntries.put(record.payload as SyncPayloadByEntity['dictionaryEntries'])
      break
    case 'wordbook':
      await db.wordbook.put(record.payload as SyncPayloadByEntity['wordbook'])
      break
    case 'reviewState':
      await db.reviewState.put(record.payload as SyncPayloadByEntity['reviewState'])
      break
    case 'reviewLogs':
      await putReviewLog(record.payload as SyncPayloadByEntity['reviewLogs'], record.updatedAt, record.sourceClientId)
      return
    case 'settings':
      await db.settings.put(record.payload as SyncPayloadByEntity['settings'])
      break
    case 'aiOverrides':
      await db.aiOverrides.put(record.payload as SyncPayloadByEntity['aiOverrides'])
      break
    case 'aiOverrideHistory':
      await putAiOverrideHistory(
        record.payload as SyncPayloadByEntity['aiOverrideHistory'],
        record.updatedAt,
        record.sourceClientId,
      )
      return
  }

  await markRecordChanged(record.entity, record.recordId, record.updatedAt)
  await db.syncRecords.update(syncRecordKey(record.entity, record.recordId), {
    sourceClientId: record.sourceClientId,
  })
}

export async function applyRemoteRecords(records: SyncRecord[]): Promise<void> {
  if (records.length === 0) {
    return
  }

  const safeRecords = records.filter(
    (record) => record.entity !== 'settings' || !SENSITIVE_SETTING_KEYS.has((record.payload as SettingItem).key),
  )
  const metadata = safeRecords.map((record) => ({
    key: syncRecordKey(record.entity, record.recordId),
    entity: record.entity,
    recordId: record.recordId,
    updatedAt: record.updatedAt,
    sourceClientId: record.sourceClientId,
  }))
  const metadataKeys = metadata.map((row) => row.key)

  const dictionaryEntries = safeRecords
    .filter((record) => record.entity === 'dictionaryEntries')
    .map((record) => record.payload as SyncPayloadByEntity['dictionaryEntries'])
  const wordbook = safeRecords
    .filter((record) => record.entity === 'wordbook')
    .map((record) => record.payload as SyncPayloadByEntity['wordbook'])
  const reviewState = safeRecords
    .filter((record) => record.entity === 'reviewState')
    .map((record) => record.payload as SyncPayloadByEntity['reviewState'])
  const settings = safeRecords
    .filter((record) => record.entity === 'settings')
    .map((record) => record.payload as SyncPayloadByEntity['settings'])
  const aiOverrides = safeRecords
    .filter((record) => record.entity === 'aiOverrides')
    .map((record) => record.payload as SyncPayloadByEntity['aiOverrides'])

  const reviewLogRecords = safeRecords.filter((record) => record.entity === 'reviewLogs')
  const historyRecords = safeRecords.filter((record) => record.entity === 'aiOverrideHistory')

  const reviewLogsBySyncId = new Map((await db.reviewLogs.toArray()).map((row) => [reviewLogSyncId(row), row]))
  const reviewLogs = reviewLogRecords.map((record) => {
    const payload = record.payload as SyncPayloadByEntity['reviewLogs']
    const existing = reviewLogsBySyncId.get(record.recordId)
    return existing ? { ...payload, id: existing.id } : payload
  })

  const historyBySyncId = new Map(
    (await db.aiOverrideHistory.toArray()).map((row) => [aiOverrideHistorySyncId(row), row]),
  )
  const history = historyRecords.map((record) => {
    const payload = record.payload as SyncPayloadByEntity['aiOverrideHistory']
    const existing = historyBySyncId.get(record.recordId)
    return existing ? { ...payload, id: existing.id } : payload
  })

  await db.transaction(
    'rw',
    [
      db.dictionaryEntries,
      db.wordbook,
      db.reviewState,
      db.reviewLogs,
      db.settings,
      db.aiOverrides,
      db.aiOverrideHistory,
      db.syncRecords,
      db.syncTombstones,
    ],
    async () => {
      if (dictionaryEntries.length > 0) {
        await db.dictionaryEntries.bulkPut(dictionaryEntries)
      }
      if (wordbook.length > 0) {
        await db.wordbook.bulkPut(wordbook)
      }
      if (reviewState.length > 0) {
        await db.reviewState.bulkPut(reviewState)
      }
      if (reviewLogs.length > 0) {
        await db.reviewLogs.bulkPut(reviewLogs)
      }
      if (settings.length > 0) {
        await db.settings.bulkPut(settings)
      }
      if (aiOverrides.length > 0) {
        await db.aiOverrides.bulkPut(aiOverrides)
      }
      if (history.length > 0) {
        await db.aiOverrideHistory.bulkPut(history)
      }
      if (metadata.length > 0) {
        await db.syncRecords.bulkPut(metadata)
        await db.syncTombstones.bulkDelete(metadataKeys)
      }
    },
  )
}

async function deleteReviewLogBySyncId(recordId: string): Promise<void> {
  const [wordId, reviewedAt] = recordId.split('|')
  if (!wordId || !reviewedAt) {
    return
  }

  const candidates = await db.reviewLogs.where('[wordId+reviewedAt]').equals([wordId, reviewedAt]).toArray()
  const existing = candidates.find((row) => reviewLogSyncId(row) === recordId)
  if (existing?.id !== undefined) {
    await db.reviewLogs.delete(existing.id)
  }
}

async function deleteAiOverrideHistoryBySyncId(recordId: string): Promise<void> {
  const existing = (await db.aiOverrideHistory.toArray()).find((row) => aiOverrideHistorySyncId(row) === recordId)
  if (existing?.id !== undefined) {
    await db.aiOverrideHistory.delete(existing.id)
  }
}

export async function applyRemoteDeletion(tombstone: SyncDeletedRecord): Promise<void> {
  switch (tombstone.entity) {
    case 'dictionaryEntries':
      await db.dictionaryEntries.delete(tombstone.recordId)
      break
    case 'wordbook':
      await db.wordbook.delete(tombstone.recordId)
      break
    case 'reviewState':
      await db.reviewState.delete(tombstone.recordId)
      break
    case 'reviewLogs':
      await deleteReviewLogBySyncId(tombstone.recordId)
      break
    case 'settings':
      if (!SENSITIVE_SETTING_KEYS.has(tombstone.recordId)) {
        await db.settings.delete(tombstone.recordId)
      }
      break
    case 'aiOverrides':
      await db.aiOverrides.delete(tombstone.recordId)
      break
    case 'aiOverrideHistory':
      await deleteAiOverrideHistoryBySyncId(tombstone.recordId)
      break
  }

  const row: SyncTombstone = {
    key: syncRecordKey(tombstone.entity, tombstone.recordId),
    entity: tombstone.entity,
    recordId: tombstone.recordId,
    deletedAt: tombstone.deletedAt,
    sourceClientId: tombstone.sourceClientId,
  }
  await db.syncTombstones.put(row)
  await db.syncRecords.delete(row.key)
}

export async function applyRemoteDeletions(tombstones: SyncDeletedRecord[]): Promise<void> {
  if (tombstones.length === 0) {
    return
  }

  const wordbookIds = tombstones.filter((row) => row.entity === 'wordbook').map((row) => row.recordId)
  const reviewStateIds = tombstones.filter((row) => row.entity === 'reviewState').map((row) => row.recordId)
  const dictionaryEntryIds = tombstones
    .filter((row) => row.entity === 'dictionaryEntries')
    .map((row) => row.recordId)
  const settingIds = tombstones
    .filter((row) => row.entity === 'settings' && !SENSITIVE_SETTING_KEYS.has(row.recordId))
    .map((row) => row.recordId)
  const aiOverrideIds = tombstones.filter((row) => row.entity === 'aiOverrides').map((row) => row.recordId)

  const reviewLogIds = new Set(tombstones.filter((row) => row.entity === 'reviewLogs').map((row) => row.recordId))
  const reviewLogLocalIds = (await db.reviewLogs.toArray())
    .filter((row) => reviewLogIds.has(reviewLogSyncId(row)) && row.id !== undefined)
    .map((row) => row.id!)

  const historyIds = new Set(
    tombstones.filter((row) => row.entity === 'aiOverrideHistory').map((row) => row.recordId),
  )
  const historyLocalIds = (await db.aiOverrideHistory.toArray())
    .filter((row) => historyIds.has(aiOverrideHistorySyncId(row)) && row.id !== undefined)
    .map((row) => row.id!)

  const rows: SyncTombstone[] = tombstones.map((row) => ({
    key: syncRecordKey(row.entity, row.recordId),
    entity: row.entity,
    recordId: row.recordId,
    deletedAt: row.deletedAt,
    sourceClientId: row.sourceClientId,
  }))

  await db.transaction(
    'rw',
    [
      db.dictionaryEntries,
      db.wordbook,
      db.reviewState,
      db.reviewLogs,
      db.settings,
      db.aiOverrides,
      db.aiOverrideHistory,
      db.syncRecords,
      db.syncTombstones,
    ],
    async () => {
      await Promise.all([
        db.dictionaryEntries.bulkDelete(dictionaryEntryIds),
        db.wordbook.bulkDelete(wordbookIds),
        db.reviewState.bulkDelete(reviewStateIds),
        db.reviewLogs.bulkDelete(reviewLogLocalIds),
        db.settings.bulkDelete(settingIds),
        db.aiOverrides.bulkDelete(aiOverrideIds),
        db.aiOverrideHistory.bulkDelete(historyLocalIds),
      ])
      await db.syncTombstones.bulkPut(rows)
      await db.syncRecords.bulkDelete(rows.map((row) => row.key))
    },
  )
}

export function compareIso(left: string | undefined, right: string | undefined): number {
  return (left ?? EPOCH).localeCompare(right ?? EPOCH)
}
