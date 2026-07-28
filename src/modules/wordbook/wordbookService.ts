import { db } from '../../db/database'
import type {
  AddToWordbookResult,
  DailyLearningSession,
  LearningUnit,
  WordbookItem,
  WordbookWithEntry,
} from '../../types/models'
import { applyAiOverrides } from '../dictionary/entryOverrideMapper'
import { invalidateStudyPlanCache } from '../review/reviewService'
import { requestWordRelearning } from '../review/dailyQueueService'
import { cardToReviewState } from '../review/scheduler'
import { createEmptyCard } from 'ts-fsrs'
import { dictionaryEntryFromWordbook, repairVocabularyIntegrity, snapshotDictionaryEntry, unresolvedVocabularyEntry } from './vocabularyIntegrity'
import { addWordToStudyList, ensureSystemStudyLists, LOOKUP_LIST_ID, removeWordFromStudyList } from './studyListService'
import { markStudyDataChanged } from '../review/studyDataRevision'
import {
  markPayloadChanged,
  markRecordChanged,
  markRecordDeleted,
  reviewLogSyncId,
} from '../sync/localSyncStore'

export const WORDBOOK_UPDATED_EVENT = 'wordsbook:updated'

function emitWordbookUpdatedEvent(): void {
  if (typeof window === 'undefined') {
    return
  }

  window.dispatchEvent(new CustomEvent(WORDBOOK_UPDATED_EVENT))
}

export async function listWordbookItems(): Promise<WordbookWithEntry[]> {
  await repairVocabularyIntegrity()
  const items = await db.wordbook.where('archived').equals(0).sortBy('addedAt')

  if (items.length === 0) {
    return []
  }

  const entryIds = items.map((item) => item.entryId)
  const rawEntries = await db.dictionaryEntries.bulkGet(entryIds)
  const entries = await applyAiOverrides(
    rawEntries.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
  )
  const entryMap = new Map(entries.map((entry) => [entry.entryId, entry]))

  const stateRows = await db.reviewState.bulkGet(items.map((item) => item.wordId))

  return items
    .map((item, index) => {
      const entry = entryMap.get(item.entryId) ?? dictionaryEntryFromWordbook(item) ?? unresolvedVocabularyEntry(item)

      return {
        item,
        entry,
        reviewState: stateRows[index] ?? undefined,
      }
    })
    .filter((value): value is WordbookWithEntry => value !== undefined)
}

export async function addToWordbook(entryId: string): Promise<AddToWordbookResult> {
  const sourceEntry = await db.dictionaryEntries.get(entryId)
  if (!sourceEntry) throw new Error('词条不存在，请重新查词后再加入')
  const existing = await db.wordbook.where('entryId').equals(entryId).first()
    ?? await db.wordbook.where('headwordLower').equals(sourceEntry.headwordLower).first()
  if (existing) {
    const now = new Date().toISOString()
    await db.transaction('rw', [db.wordbook, db.reviewState, db.syncMeta, db.syncRecords, db.syncTombstones], async () => {
      const restored = {
        ...existing,
        entryId,
        headword: sourceEntry.headword,
        headwordLower: sourceEntry.headwordLower,
        entrySnapshot: snapshotDictionaryEntry(sourceEntry),
        integrityStatus: 'ready' as const,
        archived: 0,
        addedAt: existing.archived !== 0 ? now : existing.addedAt,
      } as WordbookItem
      if (JSON.stringify(restored) !== JSON.stringify(existing)) {
        await db.wordbook.put(restored)
        await markPayloadChanged('wordbook', restored, now)
      }

      const state = await db.reviewState.get(existing.wordId)
      if (!state) {
        const nextState = {
          wordId: existing.wordId,
          cycle: 0,
          nextReviewAt: now,
          successCount: 0,
          lapseCount: 0,
          totalReviews: 0,
        }
        await db.reviewState.put(nextState)
        await markRecordChanged('reviewState', existing.wordId, now)
      }
    })
    invalidateStudyPlanCache()
    await ensureSystemStudyLists()
    await addWordToStudyList(LOOKUP_LIST_ID, existing.wordId, 'lookup')
    emitWordbookUpdatedEvent()
    return { wordId: existing.wordId, alreadyExists: true }
  }

  const now = new Date().toISOString()
  const wordId = crypto.randomUUID()

  const item: WordbookItem = {
    wordId,
    entryId,
    headword: sourceEntry.headword,
    headwordLower: sourceEntry.headwordLower,
    entrySnapshot: snapshotDictionaryEntry(sourceEntry),
    integrityStatus: 'ready',
    addedAt: now,
    note: '',
    tags: [],
    archived: 0,
  }

  await db.transaction('rw', [db.wordbook, db.reviewState, db.syncMeta, db.syncRecords, db.syncTombstones], async () => {
    await db.wordbook.put(item)
    const reviewState = {
      wordId,
      cycle: 0,
      nextReviewAt: now,
      successCount: 0,
      lapseCount: 0,
      totalReviews: 0,
    }
    await db.reviewState.put(reviewState)
    await markPayloadChanged('wordbook', item, now)
    await markRecordChanged('reviewState', wordId, now)
  })
  invalidateStudyPlanCache()
  await ensureSystemStudyLists()
  await addWordToStudyList(LOOKUP_LIST_ID, wordId, 'lookup')
  emitWordbookUpdatedEvent()

  return { wordId, alreadyExists: false }
}

/**
 * Backwards-compatible name for the safe default action. Review history and
 * FSRS stability are preserved; the active session is revised immediately.
 */
export async function resetWordForRelearning(wordId: string, listId?: string, at = new Date()): Promise<void> {
  const item = await db.wordbook.get(wordId)
  if (!item) throw new Error('单词不存在')
  await ensureSystemStudyLists()
  if (listId) await addWordToStudyList(listId, wordId, 'lookup')

  const [memberships, lists] = await Promise.all([
    db.studyListItems.where('wordId').equals(wordId).toArray(),
    db.studyLists.toArray(),
  ])
  const listMap = new Map(lists.map((list) => [list.listId, list]))
  const learningMemberships = memberships.filter((membership) => listMap.get(membership.listId)?.systemType !== 'lookup')
  if (!learningMemberships.length) throw new Error('请先选择一个学习词表')
  const now = at.toISOString()
  const refreshedMemberships = learningMemberships.map((membership) => ({
    ...membership,
    learningEnabled: 1 as const,
    autoActivate: 0 as const,
  }))
  await db.transaction('rw', [db.wordbook, db.studyListItems, db.syncMeta, db.syncRecords, db.syncTombstones], async () => {
    const restored = { ...item, archived: 0 as const }
    await db.wordbook.put(restored)
    await markPayloadChanged('wordbook', restored, now)
    await db.studyListItems.bulkPut(refreshedMemberships)
    for (const membership of refreshedMemberships) await markPayloadChanged('studyListItems', membership, now)
  })
  await requestWordRelearning(wordId, at)
  await markStudyDataChanged()
  invalidateStudyPlanCache()
  emitWordbookUpdatedEvent()
}

/** Destructive escape hatch; callers must obtain a second explicit confirmation. */
export async function clearWordLearningHistory(wordId: string, listId?: string, at = new Date()): Promise<void> {
  const item = await db.wordbook.get(wordId)
  if (!item) throw new Error('单词不存在')
  await ensureSystemStudyLists()
  if (listId) await addWordToStudyList(listId, wordId, 'lookup')

  const [memberships, lists, logs, queueItems, queueAttempts, contextAttempts, sessions] = await Promise.all([
    db.studyListItems.where('wordId').equals(wordId).toArray(),
    db.studyLists.toArray(),
    db.reviewLogs.where('wordId').equals(wordId).toArray(),
    db.dailyQueueItems.where('wordId').equals(wordId).toArray(),
    db.dailyQueueAttempts.where('wordId').equals(wordId).toArray(),
    db.contextAttempts.where('wordId').equals(wordId).toArray(),
    db.dailyLearningSessions.toArray(),
  ])
  const listMap = new Map(lists.map((list) => [list.listId, list]))
  const learningMemberships = memberships.filter((membership) => listMap.get(membership.listId)?.systemType !== 'lookup')
  if (!learningMemberships.length) throw new Error('请先选择一个学习词表')

  const now = at.toISOString()
  const refreshedMemberships = learningMemberships.map((membership) => ({
    ...membership,
    learningEnabled: 1 as const,
    autoActivate: 0 as const,
    addedAt: now,
  }))
  const refreshedItem: WordbookItem = { ...item, addedAt: now, archived: 0 }
  const freshState = cardToReviewState(wordId, createEmptyCard(now), {
    wordId,
    cycle: 0,
    nextReviewAt: now,
    successCount: 0,
    lapseCount: 0,
    totalReviews: 0,
  })
  freshState.successCount = 0
  freshState.lapseCount = 0
  freshState.totalReviews = 0

  const parseUnits = (raw: string | undefined): LearningUnit[] => {
    try {
      const value = JSON.parse(raw ?? '[]')
      return Array.isArray(value) ? value as LearningUnit[] : []
    } catch {
      return []
    }
  }
  const updatedSessions = sessions
    .filter((session) => session.initialWordIds.includes(wordId)
      || parseUnits(session.unitsJson).some((unit) => unit.wordIds.includes(wordId)))
    .map((session): DailyLearningSession => {
      const units = parseUnits(session.unitsJson).map((unit) => ({
        ...unit,
        wordIds: unit.wordIds.filter((id) => id !== wordId),
        dueWordIds: unit.dueWordIds.filter((id) => id !== wordId),
        newWordIds: unit.newWordIds.filter((id) => id !== wordId),
      }))
      let roundsJson = session.roundsJson
      try {
        const rounds = JSON.parse(session.roundsJson ?? '[]') as Array<{ wordIds?: string[] }>
        if (Array.isArray(rounds)) {
          roundsJson = JSON.stringify(rounds.map((round) => ({
            ...round,
            wordIds: Array.isArray(round.wordIds) ? round.wordIds.filter((id) => id !== wordId) : [],
          })))
        }
      } catch {
        // The v2 unit representation remains authoritative for malformed legacy rounds.
      }
      return {
        ...session,
        initialWordIds: session.initialWordIds.filter((id) => id !== wordId),
        unitsJson: JSON.stringify(units),
        roundsJson,
        sessionRevision: (session.sessionRevision ?? 0) + 1,
        updatedAt: now,
      }
    })

  await db.transaction('rw', [
    db.wordbook,
    db.reviewState,
    db.reviewLogs,
    db.studyListItems,
    db.contextAttempts,
    db.dailyLearningSessions,
    db.dailyQueueItems,
    db.dailyQueueAttempts,
    db.syncMeta,
    db.syncRecords,
    db.syncTombstones,
  ], async () => {
    await db.wordbook.put(refreshedItem)
    await db.reviewState.put(freshState)
    await db.reviewLogs.where('wordId').equals(wordId).delete()
    await db.studyListItems.bulkPut(refreshedMemberships)
    await db.contextAttempts.where('wordId').equals(wordId).delete()
    await db.dailyQueueItems.where('wordId').equals(wordId).delete()
    await db.dailyQueueAttempts.where('wordId').equals(wordId).delete()
    if (updatedSessions.length) await db.dailyLearningSessions.bulkPut(updatedSessions)

    await markPayloadChanged('wordbook', refreshedItem, now)
    await markRecordChanged('reviewState', wordId, now)
    for (const membership of refreshedMemberships) await markPayloadChanged('studyListItems', membership, now)
    for (const log of logs) await markRecordDeleted('reviewLogs', reviewLogSyncId(log), now)
    for (const row of queueItems) await markRecordDeleted('dailyQueueItems', row.itemId, now)
    for (const row of queueAttempts) await markRecordDeleted('dailyQueueAttempts', row.attemptId, now)
    for (const attempt of contextAttempts) await markRecordDeleted('contextAttempts', attempt.attemptId, now)
    for (const session of updatedSessions) await markPayloadChanged('dailyLearningSessions', session, now)
  })

  await requestWordRelearning(wordId, at, { commitCanonicalAgain: false, treatAsNew: true })
  await markStudyDataChanged()
  invalidateStudyPlanCache()
  emitWordbookUpdatedEvent()
}

export async function removeWordFromWordbook(wordId: string): Promise<void> {
  const [memberships, contextAttempts, queueItems, queueAttempts, sessions] = await Promise.all([
    db.studyListItems.where('wordId').equals(wordId).toArray(),
    db.contextAttempts.where('wordId').equals(wordId).toArray(),
    db.dailyQueueItems.where('wordId').equals(wordId).toArray(),
    db.dailyQueueAttempts.where('wordId').equals(wordId).toArray(),
    db.dailyLearningSessions.toArray(),
  ])
  const deletedAt = new Date().toISOString()
  const updatedSessions = sessions.flatMap((session) => {
    let units: LearningUnit[] = []
    try {
      const parsed = JSON.parse(session.unitsJson ?? '[]') as unknown
      units = Array.isArray(parsed) ? parsed as LearningUnit[] : []
    } catch {
      units = []
    }
    if (!session.initialWordIds.includes(wordId) && !units.some((unit) => unit.wordIds.includes(wordId))) return []
    const filteredUnits = units.map((unit) => ({
      ...unit,
      wordIds: unit.wordIds.filter((id) => id !== wordId),
      dueWordIds: unit.dueWordIds.filter((id) => id !== wordId),
      newWordIds: unit.newWordIds.filter((id) => id !== wordId),
    }))
    let roundsJson = session.roundsJson
    try {
      const rounds = JSON.parse(session.roundsJson ?? '[]') as Array<{ wordIds?: string[] }>
      if (Array.isArray(rounds)) {
        roundsJson = JSON.stringify(rounds.map((round) => ({
          ...round,
          wordIds: Array.isArray(round.wordIds) ? round.wordIds.filter((id) => id !== wordId) : [],
        })))
      }
    } catch {
      // Keep malformed legacy rounds; v2 units remain authoritative.
    }
    return [{
      ...session,
      initialWordIds: session.initialWordIds.filter((id) => id !== wordId),
      unitsJson: JSON.stringify(filteredUnits),
      roundsJson,
      articleStatus: session.status === 'active' ? 'stale' as const : session.articleStatus,
      sessionRevision: (session.sessionRevision ?? 0) + 1,
      updatedAt: deletedAt,
    }]
  })
  await db.transaction(
    'rw',
    [
      db.wordbook,
      db.reviewState,
      db.reviewLogs,
      db.studyListItems,
      db.contextAttempts,
      db.dailyLearningSessions,
      db.dailyQueueItems,
      db.dailyQueueAttempts,
      db.syncMeta,
      db.syncRecords,
      db.syncTombstones,
    ],
    async () => {
      const logs = await db.reviewLogs.where('wordId').equals(wordId).toArray()
      await db.wordbook.delete(wordId)
      await db.reviewState.delete(wordId)
      await db.reviewLogs.where('wordId').equals(wordId).delete()
      await db.studyListItems.where('wordId').equals(wordId).delete()
      await db.contextAttempts.where('wordId').equals(wordId).delete()
      await db.dailyQueueItems.where('wordId').equals(wordId).delete()
      await db.dailyQueueAttempts.where('wordId').equals(wordId).delete()
      if (updatedSessions.length) await db.dailyLearningSessions.bulkPut(updatedSessions)
      await markRecordDeleted('wordbook', wordId, deletedAt)
      await markRecordDeleted('reviewState', wordId, deletedAt)
      for (const log of logs) {
        await markRecordDeleted('reviewLogs', reviewLogSyncId(log), deletedAt)
      }
      for (const membership of memberships) {
        await markRecordDeleted('studyListItems', membership.membershipId, deletedAt)
      }
      for (const attempt of contextAttempts) await markRecordDeleted('contextAttempts', attempt.attemptId, deletedAt)
      for (const item of queueItems) await markRecordDeleted('dailyQueueItems', item.itemId, deletedAt)
      for (const attempt of queueAttempts) await markRecordDeleted('dailyQueueAttempts', attempt.attemptId, deletedAt)
      for (const session of updatedSessions) await markPayloadChanged('dailyLearningSessions', session, deletedAt)
    },
  )
  await markStudyDataChanged()
  invalidateStudyPlanCache()
  emitWordbookUpdatedEvent()
}

export async function updateWordbookItem(
  wordId: string,
  patch: Partial<Pick<WordbookItem, 'note' | 'tags' | 'archived'>>,
): Promise<WordbookItem> {
  const current = await db.wordbook.get(wordId)
  if (!current) {
    throw new Error('Word item not found')
  }

  const next = { ...current, ...patch }
  await db.wordbook.put(next)
  await markPayloadChanged('wordbook', next)
  if (patch.archived !== undefined) {
    await markStudyDataChanged()
    invalidateStudyPlanCache()
    emitWordbookUpdatedEvent()
  }
  return next
}

export interface WordbookEntryStatus {
  wordId: string
  listIds: string[]
}

export async function getWordbookEntryStatus(entryIds: string[]): Promise<Map<string, WordbookEntryStatus>> {
  const uniqueIds = [...new Set(entryIds)]
  if (uniqueIds.length === 0) {
    return new Map<string, WordbookEntryStatus>()
  }

  const rows = await db.wordbook.where('entryId').anyOf(uniqueIds).toArray()
  if (!rows.length) return new Map<string, WordbookEntryStatus>()
  const memberships = await db.studyListItems.where('wordId').anyOf(rows.map((row) => row.wordId)).toArray()
  const listIdsByWord = new Map<string, string[]>()
  for (const membership of memberships) {
    const listIds = listIdsByWord.get(membership.wordId) ?? []
    listIds.push(membership.listId)
    listIdsByWord.set(membership.wordId, listIds)
  }
  return new Map(rows.flatMap((row) => {
    const listIds = listIdsByWord.get(row.wordId) ?? []
    return listIds.length ? [[row.entryId, { wordId: row.wordId, listIds }] as const] : []
  }))
}

export async function removeFromLookupCollection(wordId: string): Promise<void> {
  await removeWordFromStudyList(LOOKUP_LIST_ID, wordId)
  if (await db.studyListItems.where('wordId').equals(wordId).count() === 0) {
    await removeWordFromWordbook(wordId)
    return
  }
  emitWordbookUpdatedEvent()
}

export async function getWordbookStats(): Promise<{ total: number; active: number }> {
  const total = await db.wordbook.count()
  const active = await db.wordbook.where('archived').equals(0).count()
  return { total, active }
}
