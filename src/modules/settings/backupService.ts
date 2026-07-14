import { db } from '../../db/database'
import type { BackupPayload, DictionaryEntry, ImportReport } from '../../types/models'
import { buildPrefixTokens } from '../dictionary/search'
import { ensureSystemStudyLists } from '../wordbook/studyListService'
import { repairVocabularyIntegrity } from '../wordbook/vocabularyIntegrity'

const BACKUP_SCHEMA_VERSION = 5

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
  return entry.dictionaryId === 'ai-local' || entry.dictionaryId === 'user-import' || entry.entryId.startsWith('ai:') || entry.entryId.startsWith('import:')
}

async function listPortableDictionaryEntries(): Promise<DictionaryEntry[]> {
  const [localEntries, words] = await Promise.all([
    db.dictionaryEntries.filter(isLocalUserDictionaryEntry).toArray(),
    db.wordbook.toArray(),
  ])
  const referenced = (await db.dictionaryEntries.bulkGet(words.map((word) => word.entryId)))
    .filter((entry): entry is DictionaryEntry => Boolean(entry))
  return [...new Map([...localEntries, ...referenced].map((entry) => [entry.entryId, entry])).values()]
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
  await repairVocabularyIntegrity()
  const payload: BackupPayload = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    dictionaryEntries: await listPortableDictionaryEntries(),
    wordbook: await db.wordbook.toArray(),
    reviewState: await db.reviewState.toArray(),
    reviewLogs: await db.reviewLogs.toArray(),
    settings: (await db.settings.toArray()).filter((row) => row.key !== 'deepseekApiKey'),
    aiOverrides: await db.aiOverrides.toArray(),
    aiOverrideHistory: await db.aiOverrideHistory.toArray(),
    studyLists: await db.studyLists.toArray(),
    studyListItems: await db.studyListItems.toArray(),
    readingSessions: await db.readingSessions.toArray(),
    contextAttempts: await db.contextAttempts.toArray(),
    dailyLearningSessions: await db.dailyLearningSessions.toArray(),
    dailyQueueItems: await db.dailyQueueItems.toArray(),
    dailyQueueAttempts: await db.dailyQueueAttempts.toArray(),
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
    ? payload.dictionaryEntries.filter((entry) => entry && typeof entry.entryId === 'string' && typeof entry.headword === 'string')
    : []
  const aiOverrides = Array.isArray(payload.aiOverrides) ? payload.aiOverrides : []
  const aiOverrideHistory = Array.isArray(payload.aiOverrideHistory) ? payload.aiOverrideHistory : []
  const studyLists = Array.isArray(payload.studyLists) ? payload.studyLists : []
  const studyListItems = Array.isArray(payload.studyListItems) ? payload.studyListItems : []
  const readingSessions = Array.isArray(payload.readingSessions) ? payload.readingSessions : []
  const contextAttempts = Array.isArray(payload.contextAttempts) ? payload.contextAttempts : []
  const dailyLearningSessions = Array.isArray(payload.dailyLearningSessions) ? payload.dailyLearningSessions : []
  const dailyQueueItems = Array.isArray(payload.dailyQueueItems) ? payload.dailyQueueItems : []
  const dailyQueueAttempts = Array.isArray(payload.dailyQueueAttempts) ? payload.dailyQueueAttempts : []

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
      db.studyLists,
      db.studyListItems,
      db.readingSessions,
      db.contextAttempts,
      db.dailyLearningSessions,
      db.dailyQueueItems,
      db.dailyQueueAttempts,
    ],
    async () => {
      await db.dictionaryEntries.bulkPut(dictionaryEntries)
      await restoreDictionaryEntryIndex(dictionaryEntries)
      await db.aiOverrides.bulkPut(aiOverrides)
      await db.aiOverrideHistory.bulkPut(aiOverrideHistory)
      await db.wordbook.bulkPut(payload.wordbook)
      await db.reviewState.bulkPut(payload.reviewState)
      await db.reviewLogs.bulkPut(payload.reviewLogs)
      await db.settings.bulkPut(payload.settings.filter((row) => row.key !== 'deepseekApiKey'))
      await db.studyLists.bulkPut(studyLists)
      await db.studyListItems.bulkPut(studyListItems)
      await db.readingSessions.bulkPut(readingSessions)
      await db.contextAttempts.bulkPut(contextAttempts)
      await db.dailyLearningSessions.bulkPut(dailyLearningSessions)
      await db.dailyQueueItems.bulkPut(dailyQueueItems)
      await db.dailyQueueAttempts.bulkPut(dailyQueueAttempts)
    },
  )

  if (studyListItems.length === 0 && payload.wordbook.length > 0) {
    await ensureSystemStudyLists()
    await db.studyListItems.bulkPut(payload.wordbook.map((word) => ({
      membershipId: `system:legacy:${word.wordId}`,
      listId: 'system:legacy',
      wordId: word.wordId,
      addedAt: word.addedAt,
    })))
  }

  await repairVocabularyIntegrity(payload.wordbook.map((word) => word.wordId))

  return {
    importedDictionaryEntries: dictionaryEntries.length,
    importedWordbook: payload.wordbook.length,
    importedReviewState: payload.reviewState.length,
    importedReviewLogs: payload.reviewLogs.length,
    importedSettings: payload.settings.length,
    importedAiOverrides: aiOverrides.length,
    importedAiOverrideHistory: aiOverrideHistory.length,
    importedStudyLists: studyLists.length,
    importedStudyListItems: studyListItems.length,
    importedReadingSessions: readingSessions.length,
    importedContextAttempts: contextAttempts.length,
  }
}
