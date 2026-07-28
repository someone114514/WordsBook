import { db } from '../../db/database'
import type {
  BackupPayload,
  DailyLearningSession,
  DailyQueueAttempt,
  DailyQueueItem,
  DictionaryEntry,
  ImportReport,
  LearningUnit,
  SettingItem,
} from '../../types/models'
import { buildPrefixTokens } from '../dictionary/search'
import { ensureSystemStudyLists } from '../wordbook/studyListService'
import { markStudyDataChanged } from '../review/studyDataRevision'
import { repairVocabularyIntegrity } from '../wordbook/vocabularyIntegrity'

const BACKUP_SCHEMA_VERSION = 6

function isBackupPayload(raw: unknown): raw is BackupPayload {
  if (typeof raw !== 'object' || raw === null) {
    return false
  }

  const candidate = raw as Record<string, unknown>
  return (
    typeof candidate.schemaVersion === 'number' &&
    Number.isInteger(candidate.schemaVersion) &&
    candidate.schemaVersion >= 1 &&
    candidate.schemaVersion <= BACKUP_SCHEMA_VERSION &&
    Array.isArray(candidate.wordbook) &&
    Array.isArray(candidate.reviewState) &&
    Array.isArray(candidate.reviewLogs) &&
    Array.isArray(candidate.settings)
  )
}

function isLocalUserDictionaryEntry(entry: DictionaryEntry): boolean {
  return entry.dictionaryId === 'ai-local' || entry.dictionaryId === 'user-import' || entry.entryId.startsWith('ai:') || entry.entryId.startsWith('import:')
}

function normalizeImportedLearningEngine(
  sessions: DailyLearningSession[],
  items: DailyQueueItem[],
  attempts: DailyQueueAttempt[],
  settings: SettingItem[],
): {
  sessions: DailyLearningSession[]
  items: DailyQueueItem[]
  attempts: DailyQueueAttempt[]
} {
  const requestedSize = Number(settings.find((row) => row.key === 'roundWordCount')?.value)
  const unitSize = Number.isFinite(requestedSize)
    ? Math.max(8, Math.min(12, Math.floor(requestedSize)))
    : 10
  const normalizedItems = new Map(items.map((item) => [item.itemId, item]))
  const normalizedAttempts = new Map(attempts.map((attempt) => [attempt.attemptId, attempt]))

  const normalizedSessions = sessions.map((session) => {
    const sessionItems = items
      .filter((item) => item.sessionId === session.sessionId)
      .sort((left, right) => left.position - right.position)
    const sessionAttempts = attempts
      .filter((attempt) => attempt.sessionId === session.sessionId)
      .sort((left, right) => left.answeredAt.localeCompare(right.answeredAt))
    let storedUnits: LearningUnit[] = []
    try {
      const parsed = JSON.parse(session.unitsJson ?? '[]') as unknown
      storedUnits = Array.isArray(parsed) ? parsed as LearningUnit[] : []
    } catch {
      storedUnits = []
    }
    const storedWordIds = new Set(storedUnits.flatMap((unit) => unit.wordIds))
    const validV2 = session.engineVersion === 2
      && storedUnits.length > 0
      && session.initialWordIds.every((wordId) => storedWordIds.has(wordId))
    const firstRowByWord = new Map<string, DailyQueueItem>()
    for (const item of sessionItems) {
      if (item.kind === 'card' && item.wordId && !firstRowByWord.has(item.wordId)) {
        firstRowByWord.set(item.wordId, item)
      }
    }
    const structureInvalid = session.status === 'active'
      && session.initialWordIds.some((wordId) => !firstRowByWord.has(wordId))
    const recoveryRows = sessionItems.filter((item) =>
      item.kind === 'card'
      && item.wordId
      && (item.status === 'pending' || item.status === 'active'))
    const sourceWordIds = validV2
      ? session.initialWordIds
      : structureInvalid
        ? [...new Set(recoveryRows.flatMap((item) => item.wordId ? [item.wordId] : []))]
        : session.initialWordIds.filter((wordId) => firstRowByWord.has(wordId))
    const generatedUnits = Array.from(
      { length: Math.ceil(sourceWordIds.length / unitSize) },
      (_, index) => {
        const wordIds = sourceWordIds.slice(index * unitSize, index * unitSize + unitSize)
        const pending = wordIds.some((wordId) => {
          const row = firstRowByWord.get(wordId)
          return row?.status === 'pending' || row?.status === 'active'
        })
        return {
          unitId: `${session.sessionId}:unit:${index + 1}`,
          index,
          wordIds,
          dueWordIds: wordIds.filter((wordId) => !firstRowByWord.get(wordId)?.wasNew),
          newWordIds: wordIds.filter((wordId) => Boolean(firstRowByWord.get(wordId)?.wasNew)),
          status: pending ? 'active' as const : 'completed' as const,
        }
      },
    )
    const generatedActiveIndex = generatedUnits.findIndex((unit) => unit.status === 'active')
    const units: LearningUnit[] = validV2
      ? storedUnits
      : generatedUnits.map((unit, index) => ({
          ...unit,
          status: generatedActiveIndex < 0 || index < generatedActiveIndex
            ? 'completed' as const
            : index === generatedActiveIndex ? 'active' as const : 'pending' as const,
        }))
    const firstActiveIndex = Math.max(0, units.findIndex((unit) => unit.status === 'active'))
    const unitByWord = new Map(units.flatMap((unit) =>
      unit.wordIds.map((wordId) => [wordId, unit] as const)))
    const canonicalByWord = new Set(sessionAttempts
      .filter((attempt) => attempt.committedToFsrs)
      .map((attempt) => attempt.wordId))
    for (const item of sessionItems) {
      const unit = item.wordId ? unitByWord.get(item.wordId) : undefined
      normalizedItems.set(item.itemId, {
        ...item,
        unitId: item.unitId ?? unit?.unitId,
        stage: item.stage ?? (
          item.reason !== 'initial'
            ? 'retry'
            : item.wasNew ? 'learn' : 'probe'
        ),
        eligibleAfterOrdinal: item.eligibleAfterOrdinal ?? 0,
        canonicalGradeCommitted: item.canonicalGradeCommitted
          ?? Boolean(item.wordId && canonicalByWord.has(item.wordId)),
        memoryStatus: item.memoryStatus ?? (item.status === 'completed' ? 'passed' : 'pending'),
      })
    }
    sessionAttempts.forEach((attempt, index) => normalizedAttempts.set(attempt.attemptId, {
      ...attempt,
      activityOrdinal: attempt.activityOrdinal ?? index + 1,
      evidenceKind: attempt.evidenceKind ?? 'unprompted-card',
      skill: attempt.skill ?? 'meaning-recall',
      hintLevel: attempt.hintLevel ?? 0,
    }))
    const activityOrdinal = Math.max(
      session.activityOrdinal ?? 0,
      ...sessionAttempts.map((attempt, index) => attempt.activityOrdinal ?? index + 1),
      0,
    )
    const hasRecoverableWork = sourceWordIds.length > 0
    return {
      ...session,
      status: structureInvalid && !hasRecoverableWork ? 'rolled-over' as const : session.status,
      phase: structureInvalid ? (hasRecoverableWork ? 'cards' as const : 'summary' as const) : session.phase,
      engineVersion: 2 as const,
      sessionRevision: session.sessionRevision ?? 1,
      activityOrdinal,
      learningStage: structureInvalid
        ? 'probe' as const
        : session.learningStage ?? (
            session.phase === 'article' ? 'read' as const
              : session.phase === 'practice' ? 'transfer' as const
                : session.phase === 'summary' ? 'transfer' as const : 'probe' as const
          ),
      activeUnitIndex: validV2 ? session.activeUnitIndex ?? firstActiveIndex : firstActiveIndex,
      activeRoundIndex: validV2 ? session.activeRoundIndex : (hasRecoverableWork ? firstActiveIndex + 1 : 0),
      unitsJson: JSON.stringify(units),
      initialWordIds: sourceWordIds,
      recoveryMode: structureInvalid ? true : session.recoveryMode,
      recoveryBacklogCount: structureInvalid ? sourceWordIds.length : session.recoveryBacklogCount,
      roundsJson: validV2 ? session.roundsJson : JSON.stringify(units.map((unit) => ({
        index: unit.index + 1,
        wordIds: unit.wordIds,
        status: unit.status,
        startedAt: unit.status === 'active' ? session.updatedAt : '',
      }))),
    }
  })
  return {
    sessions: normalizedSessions,
    items: [...normalizedItems.values()],
    attempts: [...normalizedAttempts.values()],
  }
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
  const importedDailyLearningSessions = Array.isArray(payload.dailyLearningSessions) ? payload.dailyLearningSessions : []
  const importedDailyQueueItems = Array.isArray(payload.dailyQueueItems) ? payload.dailyQueueItems : []
  const importedDailyQueueAttempts = Array.isArray(payload.dailyQueueAttempts) ? payload.dailyQueueAttempts : []
  const normalizedLearning = normalizeImportedLearningEngine(
    importedDailyLearningSessions,
    importedDailyQueueItems,
    importedDailyQueueAttempts,
    payload.settings,
  )
  const dailyLearningSessions = normalizedLearning.sessions
  const dailyQueueItems = normalizedLearning.items
  const dailyQueueAttempts = normalizedLearning.attempts

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
      source: 'migration' as const,
      addedAt: word.addedAt,
    })))
  }

  await repairVocabularyIntegrity(payload.wordbook.map((word) => word.wordId))
  await markStudyDataChanged()

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
