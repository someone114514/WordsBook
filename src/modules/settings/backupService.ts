import { db } from '../../db/database'
import type { BackupPayload, DictionaryEntry, ImportReport } from '../../types/models'
import { buildPrefixTokens } from '../dictionary/search'

const BACKUP_SCHEMA_VERSION = 2

function isBackupPayload(raw: unknown): raw is BackupPayload {
  if (typeof raw !== 'object' || raw === null) {
    return false
  }

  const candidate = raw as Record<string, unknown>
  return (
    typeof candidate.schemaVersion === 'number' &&
    Array.isArray(candidate.wordbook) &&
    Array.isArray(candidate.reviewState) &&
    Array.isArray(candidate.reviewLogs) &&
    Array.isArray(candidate.settings)
  )
}

function isLocalUserDictionaryEntry(entry: DictionaryEntry): boolean {
  return entry.dictionaryId === 'ai-local' || entry.entryId.startsWith('ai:')
}

async function listLocalUserDictionaryEntries(): Promise<DictionaryEntry[]> {
  return db.dictionaryEntries.filter(isLocalUserDictionaryEntry).toArray()
}

async function restoreDictionaryEntryIndex(entries: DictionaryEntry[]): Promise<void> {
  const tokenMap = new Map<string, Set<string>>()

  for (const entry of entries) {
    for (const token of buildPrefixTokens(entry.headwordLower || entry.headword)) {
      const bucket = tokenMap.get(token) ?? new Set<string>()
      bucket.add(entry.entryId)
      tokenMap.set(token, bucket)
    }
  }

  const tokens = [...tokenMap.keys()]
  if (tokens.length === 0) {
    return
  }

  const existingRows = await db.dictionaryIndex.bulkGet(tokens)
  await db.dictionaryIndex.bulkPut(
    tokens.map((token, index) => ({
      token,
      entryIds: [
        ...new Set([
          ...(existingRows[index]?.entryIds ?? []),
          ...(tokenMap.get(token) ?? new Set<string>()),
        ]),
      ],
    })),
  )
}

export async function exportUserData(): Promise<Blob> {
  const payload: BackupPayload = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    dictionaryEntries: await listLocalUserDictionaryEntries(),
    wordbook: await db.wordbook.toArray(),
    reviewState: await db.reviewState.toArray(),
    reviewLogs: await db.reviewLogs.toArray(),
    settings: await db.settings.toArray(),
    aiOverrides: await db.aiOverrides.toArray(),
    aiOverrideHistory: await db.aiOverrideHistory.toArray(),
  }

  const serialized = JSON.stringify(payload, null, 2)
  return new Blob([serialized], { type: 'application/json' })
}

async function blobToText(input: Blob): Promise<string> {
  return input.text()
}

export async function importUserData(input: Blob): Promise<ImportReport> {
  const text = await blobToText(input)
  const parsed: unknown = JSON.parse(text)

  if (!isBackupPayload(parsed)) {
    throw new Error('Invalid backup file format')
  }

  const payload = parsed
  const dictionaryEntries = Array.isArray(payload.dictionaryEntries)
    ? payload.dictionaryEntries.filter(isLocalUserDictionaryEntry)
    : []
  const aiOverrides = Array.isArray(payload.aiOverrides) ? payload.aiOverrides : []
  const aiOverrideHistory = Array.isArray(payload.aiOverrideHistory) ? payload.aiOverrideHistory : []

  await db.transaction(
    'rw',
    [
      db.dictionaryEntries,
      db.dictionaryIndex,
      db.wordbook,
      db.reviewState,
      db.reviewLogs,
      db.settings,
      db.aiOverrides,
      db.aiOverrideHistory,
    ],
    async () => {
      await db.dictionaryEntries.bulkPut(dictionaryEntries)
      await restoreDictionaryEntryIndex(dictionaryEntries)
      await db.aiOverrides.bulkPut(aiOverrides)
      await db.aiOverrideHistory.bulkPut(aiOverrideHistory)
      await db.wordbook.bulkPut(payload.wordbook)
      await db.reviewState.bulkPut(payload.reviewState)
      await db.reviewLogs.bulkPut(payload.reviewLogs)
      await db.settings.bulkPut(payload.settings)
    },
  )

  return {
    importedDictionaryEntries: dictionaryEntries.length,
    importedWordbook: payload.wordbook.length,
    importedReviewState: payload.reviewState.length,
    importedReviewLogs: payload.reviewLogs.length,
    importedSettings: payload.settings.length,
    importedAiOverrides: aiOverrides.length,
    importedAiOverrideHistory: aiOverrideHistory.length,
  }
}
