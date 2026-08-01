import Dexie, { type Table } from 'dexie'
import type {
  AiOverrideHistoryRecord,
  AiOverrideRecord,
  DictionaryEntry,
  DictionaryIndexRow,
  DictionaryMeta,
  ReviewLog,
  ReviewState,
  SyncMetaRecord,
  SyncRecordMeta,
  SyncTombstone,
  SettingItem,
  StudyList,
  StudyListItem,
  ReadingSession,
  ContextAttempt,
  DailyLearningSession,
  DailyQueueAttempt,
  DailyQueueItem,
  LocalSecret,
  WordbookItem,
} from '../types/models'

class WordsBookDB extends Dexie {
  dictionaryMeta!: Table<DictionaryMeta, string>
  dictionaryEntries!: Table<DictionaryEntry, string>
  dictionaryIndex!: Table<DictionaryIndexRow, string>
  wordbook!: Table<WordbookItem, string>
  reviewState!: Table<ReviewState, string>
  reviewLogs!: Table<ReviewLog, number>
  settings!: Table<SettingItem, string>
  aiOverrides!: Table<AiOverrideRecord, string>
  aiOverrideHistory!: Table<AiOverrideHistoryRecord, number>
  syncMeta!: Table<SyncMetaRecord, string>
  syncRecords!: Table<SyncRecordMeta, string>
  syncTombstones!: Table<SyncTombstone, string>
  studyLists!: Table<StudyList, string>
  studyListItems!: Table<StudyListItem, string>
  readingSessions!: Table<ReadingSession, string>
  contextAttempts!: Table<ContextAttempt, string>
  localSecrets!: Table<LocalSecret, string>
  dailyLearningSessions!: Table<DailyLearningSession, string>
  dailyQueueItems!: Table<DailyQueueItem, string>
  dailyQueueAttempts!: Table<DailyQueueAttempt, string>

  public constructor() {
    super('wordsbook-db')

    this.version(1).stores({
      dictionaryMeta: '&id, version, installedAt',
      dictionaryEntries: '&entryId, headwordLower',
      dictionaryIndex: '&token',
      wordbook: '&wordId, &entryId, addedAt, archived',
      reviewState: '&wordId, nextReviewAt, cycle, totalReviews',
      reviewLogs: '++id, wordId, reviewedAt, [wordId+reviewedAt]',
      settings: '&key',
    })

    this.version(2).stores({
      dictionaryMeta: '&id, version, installedAt',
      dictionaryEntries: '&entryId, headwordLower',
      dictionaryIndex: '&token',
      wordbook: '&wordId, &entryId, addedAt, archived',
      reviewState: '&wordId, nextReviewAt, cycle, totalReviews',
      reviewLogs: '++id, wordId, reviewedAt, [wordId+reviewedAt]',
      settings: '&key',
      aiOverrides: '&entryId, mode, createdAt',
      aiOverrideHistory: '++id, entryId, createdAt',
    })

    this.version(3).stores({
      dictionaryMeta: '&id, version, installedAt',
      dictionaryEntries: '&entryId, headwordLower',
      dictionaryIndex: '&token',
      wordbook: '&wordId, &entryId, addedAt, archived',
      reviewState: '&wordId, nextReviewAt, cycle, totalReviews',
      reviewLogs: '++id, wordId, reviewedAt, [wordId+reviewedAt]',
      settings: '&key',
      aiOverrides: '&entryId, mode, createdAt',
      aiOverrideHistory: '++id, entryId, createdAt',
      syncMeta: '&key',
      syncRecords: '&key, entity, recordId, updatedAt, deletedAt',
      syncTombstones: '&key, entity, recordId, deletedAt',
    })

    this.version(4)
      .stores({
        dictionaryMeta: '&id, version, installedAt',
        dictionaryEntries: '&entryId, headwordLower',
        dictionaryIndex: '&token',
        wordbook: '&wordId, &entryId, addedAt, archived',
        reviewState: '&wordId, nextReviewAt, cycle, totalReviews, suspendedAt, sameDayRelearnAt',
        reviewLogs: '++id, wordId, reviewedAt, rating, source, [wordId+reviewedAt]',
        settings: '&key',
        aiOverrides: '&entryId, mode, createdAt',
        aiOverrideHistory: '++id, entryId, createdAt',
        syncMeta: '&key',
        syncRecords: '&key, entity, recordId, updatedAt, deletedAt',
        syncTombstones: '&key, entity, recordId, deletedAt',
        studyLists: '&listId, studyEnabled, systemType, updatedAt',
        studyListItems: '&membershipId, listId, wordId, [listId+wordId]',
        readingSessions: '&sessionId, dayKey, status, updatedAt',
        contextAttempts: '&attemptId, sessionId, wordId, answeredAt',
        localSecrets: '&key',
      })
      .upgrade(async (transaction) => {
        const now = new Date().toISOString()
        const lists = transaction.table<StudyList, string>('studyLists')
        const memberships = transaction.table<StudyListItem, string>('studyListItems')
        const words = await transaction.table<WordbookItem, string>('wordbook').toArray()
        await lists.bulkPut([
          {
            listId: 'system:lookup',
            name: '查词收藏',
            description: '从查词页收藏的单词，不自动加入学习计划',
            studyEnabled: 0,
            systemType: 'lookup',
            createdAt: now,
            updatedAt: now,
          },
          {
            listId: 'system:legacy',
            name: '旧单词本',
            description: '升级前已经在学习的单词',
            studyEnabled: 1,
            systemType: 'legacy',
            createdAt: now,
            updatedAt: now,
          },
        ])
        await memberships.bulkPut(
          words.map((word) => ({
            membershipId: `system:legacy:${word.wordId}`,
            listId: 'system:legacy',
            wordId: word.wordId,
            addedAt: word.addedAt,
          })),
        )
      })

    this.version(5)
      .stores({
        dictionaryMeta: '&id, version, installedAt',
        dictionaryEntries: '&entryId, headwordLower',
        dictionaryIndex: '&token',
        wordbook: '&wordId, &entryId, addedAt, archived',
        reviewState: '&wordId, nextReviewAt, cycle, totalReviews, suspendedAt',
        reviewLogs: '++id, wordId, reviewedAt, rating, source, [wordId+reviewedAt]',
        settings: '&key',
        aiOverrides: '&entryId, mode, createdAt',
        aiOverrideHistory: '++id, entryId, createdAt',
        syncMeta: '&key',
        syncRecords: '&key, entity, recordId, updatedAt, deletedAt',
        syncTombstones: '&key, entity, recordId, deletedAt',
        studyLists: '&listId, studyEnabled, systemType, updatedAt',
        studyListItems: '&membershipId, listId, wordId, [listId+wordId]',
        readingSessions: '&sessionId, dayKey, status, updatedAt',
        contextAttempts: '&attemptId, sessionId, wordId, answeredAt',
        localSecrets: '&key',
        dailyLearningSessions: '&sessionId, dayKey, status, updatedAt',
        dailyQueueItems: '&itemId, sessionId, status, position, wordId, [sessionId+status+position]',
        dailyQueueAttempts: '&attemptId, sessionId, wordId, answeredAt, [sessionId+wordId]',
      })
      .upgrade(async (transaction) => {
        const now = new Date().toISOString()
        const lists = transaction.table<StudyList, string>('studyLists')
        const legacy = await lists.get('system:legacy')
        if (legacy) {
          await lists.put({
            ...legacy,
            name: '我的单词',
            description: '默认学习词表，内容会进入每日混合队列',
            systemType: 'default',
            studyEnabled: 1,
            updatedAt: now,
          })
        }
        const lookup = await lists.get('system:lookup')
        if (lookup) {
          await lists.put({
            ...lookup,
            name: '仅保存',
            description: '只保存查询结果，不进入每日学习',
            studyEnabled: 0,
            updatedAt: now,
          })
        }
      })

    this.version(6)
      .stores({
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
        studyListItems: '&membershipId, listId, wordId, [listId+wordId]',
        readingSessions: '&sessionId, dayKey, status, updatedAt',
        contextAttempts: '&attemptId, sessionId, wordId, answeredAt',
        localSecrets: '&key',
        dailyLearningSessions: '&sessionId, dayKey, status, updatedAt',
        dailyQueueItems: '&itemId, sessionId, status, position, wordId, [sessionId+status+position]',
        dailyQueueAttempts: '&attemptId, sessionId, wordId, answeredAt, [sessionId+wordId]',
      })
      .upgrade(async (transaction) => {
        const wordsTable = transaction.table<WordbookItem, string>('wordbook')
        const entriesTable = transaction.table<DictionaryEntry, string>('dictionaryEntries')
        const words = await wordsTable.toArray()
        const entries = await entriesTable.bulkGet(words.map((word) => word.entryId))
        const updatedWords = words.map((word, index) => {
          const entry = entries[index]
          const derived = word.entryId.split(':').reverse().find((part) => /^[a-z][a-z' -]{0,79}$/i.test(part))
          const headword = entry?.headword ?? word.headword ?? word.entrySnapshot?.headword ?? derived
          const usable = Boolean(headword && /[a-z]/i.test(headword) && !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(headword))
          return {
            ...word,
            headword: usable ? headword : undefined,
            headwordLower: usable ? (entry?.headwordLower || headword!.toLowerCase()) : undefined,
            entrySnapshot: entry ? {
              headword: entry.headword,
              headwordLower: entry.headwordLower,
              phonetic: entry.phonetic,
              posList: entry.posList,
              sensesJson: entry.sensesJson,
              examplesJson: entry.examplesJson,
              usageJson: entry.usageJson,
              synonymsJson: entry.synonymsJson,
              antonymsJson: entry.antonymsJson,
              audioKey: entry.audioKey,
            } : word.entrySnapshot,
            integrityStatus: usable ? 'ready' as const : 'needs-repair' as const,
          }
        })
        if (updatedWords.length) await wordsTable.bulkPut(updatedWords)

        const queueTable = transaction.table<DailyQueueItem, string>('dailyQueueItems')
        await queueTable.toCollection().modify((item) => {
          const longTerm = item.startingLongTermRetrievability ?? item.retrievability ?? 0
          item.startingLongTermRetrievability = longTerm
          item.todayMastery ??= longTerm >= 0.9 ? 40 : longTerm >= 0.75 ? 30 : longTerm >= 0.5 ? 20 : 0
          item.attemptCount ??= Math.max(0, item.attemptNo - 1)
          item.nextGap ??= 0
          item.tomorrowPriority ??= false
          item.maxAttempts = 5
        })

        const sessions = transaction.table<ReadingSession, string>('readingSessions')
        await sessions.toCollection().modify((session) => {
          try {
            const targets = JSON.parse(session.targetsJson) as Array<{ wordId?: string; headword?: string }>
            if (targets.some((target) => !target.headword || target.headword === target.wordId || /^[0-9a-f-]{36}$/i.test(target.headword))) {
              session.status = 'failed'
              session.error = '词条引用已修复，请重新生成文章'
              session.updatedAt = new Date().toISOString()
            }
          } catch {
            session.status = 'failed'
            session.error = '文章缓存格式损坏，请重新生成'
          }
        })
      })

    this.version(7)
      .stores({
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
      })
      .upgrade(async (transaction) => {
        const membershipsTable = transaction.table<StudyListItem, string>('studyListItems')
        const statesTable = transaction.table<ReviewState, string>('reviewState')
        const listsTable = transaction.table<StudyList, string>('studyLists')
        const syncMetaTable = transaction.table<SyncMetaRecord, string>('syncMeta')
        const syncRecordsTable = transaction.table<SyncRecordMeta, string>('syncRecords')
        const [memberships, states, lists, client] = await Promise.all([
          membershipsTable.toArray(),
          statesTable.toArray(),
          listsTable.toArray(),
          syncMetaTable.get('clientId'),
        ])
        const stateByWord = new Map(states.map((state) => [state.wordId, state]))
        const enabledListIds = new Set(lists.filter((list) => list.studyEnabled === 1).map((list) => list.listId))
        const unreviewedLegacy = memberships.filter((membership) => {
          const state = stateByWord.get(membership.wordId)
          return enabledListIds.has(membership.listId)
            && (membership.source ?? 'migration') === 'migration'
            && (state?.reps ?? state?.totalReviews ?? 0) === 0
        })
        const repairLegacyBulkImport = unreviewedLegacy.length >= 200
        const now = new Date().toISOString()
        const changed = memberships.flatMap((membership) => {
          const state = stateByWord.get(membership.wordId)
          const neverReviewed = (state?.reps ?? state?.totalReviews ?? 0) === 0
          const shouldPause = membership.source === 'import'
            || (repairLegacyBulkImport
              && enabledListIds.has(membership.listId)
              && (membership.source ?? 'migration') === 'migration'
              && neverReviewed)
          const learningEnabled: 0 | 1 = shouldPause ? 0 : 1
          const autoActivate: 0 | 1 = shouldPause ? 1 : 0
          return membership.learningEnabled === learningEnabled && membership.autoActivate === autoActivate
            ? []
            : [{ ...membership, learningEnabled, autoActivate }]
        })
        if (changed.length) {
          await membershipsTable.bulkPut(changed)
          await syncRecordsTable.bulkPut(changed.map((membership) => ({
            key: `studyListItems:${membership.membershipId}`,
            entity: 'studyListItems' as const,
            recordId: membership.membershipId,
            updatedAt: now,
            sourceClientId: typeof client?.value === 'string' ? client.value : undefined,
          })))
        }
      })

    this.version(8)
      .stores({
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
      })
      .upgrade(async (transaction) => {
        const sessions = transaction.table<DailyLearningSession, string>('dailyLearningSessions')
        const queue = transaction.table<DailyQueueItem, string>('dailyQueueItems')
        const allSessions = await sessions.toArray()
        for (const session of allSessions) {
          const items = (await queue.where('sessionId').equals(session.sessionId).toArray())
            .sort((left, right) => left.position - right.position)
          const wordIds = [...new Set(items.filter((item) => item.kind === 'card' && item.wordId).map((item) => item.wordId!))]
          const chunks = Array.from({ length: Math.ceil(wordIds.length / 5) }, (_, index) => wordIds.slice(index * 5, index * 5 + 5))
          const pendingWordIds = new Set(items
            .filter((item) => item.kind === 'card' && item.wordId && (item.status === 'pending' || item.status === 'active'))
            .map((item) => item.wordId!))
          const activeRoundIndex = Math.max(1, chunks.findIndex((chunk) => chunk.some((wordId) => pendingWordIds.has(wordId))) + 1)
          const roundByWordId = new Map(chunks.flatMap((chunk, index) => chunk.map((wordId) => [wordId, index + 1] as const)))
          const rounds = chunks.map((wordIds, index) => ({
            index: index + 1,
            wordIds,
            status: index + 1 < activeRoundIndex
              ? 'completed'
              : index + 1 === activeRoundIndex ? 'active' : 'pending',
          }))
          await sessions.put({
            ...session,
            activeRoundIndex: session.activeRoundIndex ?? activeRoundIndex,
            roundsJson: session.roundsJson ?? JSON.stringify(rounds),
          })
          if (items.length) await queue.bulkPut(items.map((item) => ({
            ...item,
            roundIndex: item.roundIndex ?? (item.wordId ? roundByWordId.get(item.wordId) : undefined) ?? 1,
          })))
        }
      })

    this.version(9)
      .stores({
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
        dailyLearningSessions: '&sessionId, dayKey, status, updatedAt, sessionRevision',
        dailyQueueItems: '&itemId, sessionId, status, position, wordId, notBeforeAt, eligibleAfterOrdinal, [sessionId+status+position], [sessionId+status+eligibleAfterOrdinal], [sessionId+status+notBeforeAt]',
        dailyQueueAttempts: '&attemptId, sessionId, wordId, answeredAt, activityOrdinal, [sessionId+wordId]',
      })
      .upgrade(async (transaction) => {
        const sessions = transaction.table<DailyLearningSession, string>('dailyLearningSessions')
        const queue = transaction.table<DailyQueueItem, string>('dailyQueueItems')
        const attempts = transaction.table<DailyQueueAttempt, string>('dailyQueueAttempts')
        const settings = transaction.table<SettingItem, string>('settings')
        const configuredBatchRounds = await settings.get('articleEveryRounds')
        const batchRounds = typeof configuredBatchRounds?.value === 'number'
          ? Math.max(1, Math.floor(configuredBatchRounds.value))
          : 2
        const configuredUnitSize = await settings.get('roundWordCount')
        const recoveryUnitSize = typeof configuredUnitSize?.value === 'number'
          ? Math.min(12, Math.max(8, Math.floor(configuredUnitSize.value)))
          : 10

        for (const session of await sessions.toArray()) {
          const rows = await queue.where('sessionId').equals(session.sessionId).sortBy('position')
          const sessionAttempts = await attempts.where('sessionId').equals(session.sessionId).sortBy('answeredAt')
          const initialWordSet = new Set(session.initialWordIds)
          const firstCanonicalRowByWord = new Map<string, DailyQueueItem>()
          for (const row of rows) {
            if (!row.wordId || row.kind !== 'card') continue
            if (initialWordSet.size && !initialWordSet.has(row.wordId)) continue
            if (!firstCanonicalRowByWord.has(row.wordId)) firstCanonicalRowByWord.set(row.wordId, row)
          }
          const missingInitialRows = session.initialWordIds.filter((wordId) => !firstCanonicalRowByWord.has(wordId))
          const structureInvalid = session.status === 'active'
            && session.initialWordIds.length > 0
            && (firstCanonicalRowByWord.size === 0 || missingInitialRows.length > 0)
          const recoveryRowByWord = new Map<string, DailyQueueItem>()
          if (structureInvalid) {
            for (const row of rows) {
              if (row.kind !== 'card' || !row.wordId || (row.status !== 'pending' && row.status !== 'active')) continue
              if (!recoveryRowByWord.has(row.wordId)) recoveryRowByWord.set(row.wordId, row)
            }
          }
          const canonicalRows = structureInvalid ? [...recoveryRowByWord.values()] : [...firstCanonicalRowByWord.values()]
          const roundWordIds = new Map<number, string[]>()
          for (const [index, row] of canonicalRows.entries()) {
            if (!row.wordId) continue
            const roundIndex = structureInvalid
              ? Math.floor(index / recoveryUnitSize) + 1
              : row.roundIndex ?? 1
            const bucket = roundWordIds.get(roundIndex) ?? []
            if (!bucket.includes(row.wordId)) bucket.push(row.wordId)
            roundWordIds.set(roundIndex, bucket)
          }
          const unitByRound = new Map<number, number>()
          const unitByWord = new Map<string, number>()
          const unitWordIds = new Map<number, string[]>()
          for (const roundIndex of [...roundWordIds.keys()].sort((a, b) => a - b)) {
            const unitIndex = structureInvalid
              ? roundIndex
              : Math.floor((roundIndex - 1) / batchRounds) + 1
            unitByRound.set(roundIndex, unitIndex)
            const bucket = unitWordIds.get(unitIndex) ?? []
            for (const wordId of roundWordIds.get(roundIndex) ?? []) {
              if (!bucket.includes(wordId)) bucket.push(wordId)
              unitByWord.set(wordId, unitIndex)
            }
            unitWordIds.set(unitIndex, bucket)
          }
          const rowByWord = new Map(canonicalRows.flatMap((row) => row.wordId ? [[row.wordId, row] as const] : []))
          const activeRound = session.activeRoundIndex ?? 1
          const activeUnitIndex = structureInvalid
            ? 0
            : Math.min(
                Math.max(0, unitWordIds.size - 1),
                Math.floor((Math.max(1, activeRound) - 1) / batchRounds),
              )
          const units = [...unitWordIds.entries()].map(([unitNumber, wordIds]) => ({
            unitId: `${session.sessionId}:unit:${unitNumber}`,
            index: unitNumber - 1,
            wordIds,
            dueWordIds: wordIds.filter((wordId) => !rowByWord.get(wordId)?.wasNew),
            newWordIds: wordIds.filter((wordId) => Boolean(rowByWord.get(wordId)?.wasNew)),
            status: session.status !== 'active' ? 'completed' as const
              : unitNumber - 1 < activeUnitIndex ? 'completed' as const
                : unitNumber - 1 === activeUnitIndex ? 'active' as const : 'pending' as const,
          }))
          const recoveryWordIds = canonicalRows.flatMap((row) => row.wordId ? [row.wordId] : [])
          const hasRecoverableWork = !structureInvalid || recoveryWordIds.length > 0
          const activityOrdinal = Math.max(
            session.activityOrdinal ?? 0,
            ...sessionAttempts.map((attempt, index) => attempt.activityOrdinal ?? index + 1),
            0,
          )
          await sessions.put({
            ...session,
            status: structureInvalid && !hasRecoverableWork ? 'rolled-over' : session.status,
            phase: structureInvalid ? (hasRecoverableWork ? 'cards' : 'summary') : session.phase,
            engineVersion: 2,
            sessionRevision: session.sessionRevision ?? 1,
            activityOrdinal,
            learningStage: structureInvalid ? 'probe'
              : session.phase === 'article' ? 'read'
              : session.phase === 'practice' ? 'transfer'
                : session.phase === 'summary' ? 'transfer' : 'probe',
            activeUnitIndex,
            unitsJson: JSON.stringify(units),
            initialWordIds: structureInvalid ? recoveryWordIds : session.initialWordIds,
            recoveryMode: structureInvalid ? true : session.recoveryMode,
            recoveryBacklogCount: structureInvalid ? recoveryWordIds.length : session.recoveryBacklogCount,
            activeRoundIndex: structureInvalid && hasRecoverableWork ? 1 : session.activeRoundIndex,
            roundsJson: structureInvalid
              ? JSON.stringify(units.map((unit) => ({
                  index: unit.index + 1,
                  wordIds: unit.wordIds,
                  status: unit.status,
                  startedAt: unit.status === 'active' ? session.updatedAt : '',
                })))
              : session.roundsJson,
          })
          if (rows.length) {
            await queue.bulkPut(rows.map((row) => {
              const unitIndex = row.wordId
                ? unitByWord.get(row.wordId) ?? unitByRound.get(row.roundIndex ?? 1) ?? activeUnitIndex + 1
                : activeUnitIndex + 1
              const canonicalCommitted = sessionAttempts.some((attempt) => attempt.wordId === row.wordId && attempt.committedToFsrs)
              return {
                ...row,
                unitId: row.unitId ?? `${session.sessionId}:unit:${unitIndex}`,
                stage: row.stage ?? (row.reason === 'initial' && !row.wasNew ? 'probe' : row.reason === 'initial' ? 'learn' : 'retry'),
                eligibleAfterOrdinal: row.eligibleAfterOrdinal ?? 0,
                canonicalGradeCommitted: row.canonicalGradeCommitted ?? canonicalCommitted,
                memoryStatus: row.memoryStatus ?? (row.status === 'completed' ? 'passed' : 'pending'),
              }
            }))
          }
          if (sessionAttempts.length) {
            await attempts.bulkPut(sessionAttempts.map((attempt, index) => ({
              ...attempt,
              activityOrdinal: attempt.activityOrdinal ?? index + 1,
              evidenceKind: attempt.evidenceKind ?? 'unprompted-card',
              skill: attempt.skill ?? 'meaning-recall',
              hintLevel: attempt.hintLevel ?? 0,
            })))
          }
        }
      })
  }
}

export const db = new WordsBookDB()
