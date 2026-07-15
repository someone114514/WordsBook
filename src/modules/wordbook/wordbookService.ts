import { db } from '../../db/database'
import type { AddToWordbookResult, WordbookItem, WordbookWithEntry } from '../../types/models'
import { applyAiOverrides } from '../dictionary/entryOverrideMapper'
import { invalidateStudyPlanCache } from '../review/reviewService'
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

export async function resetWordForRelearning(wordId: string, listId?: string, at = new Date()): Promise<void> {
  const item = await db.wordbook.get(wordId)
  if (!item) throw new Error('单词不存在')
  await ensureSystemStudyLists()
  if (listId) await addWordToStudyList(listId, wordId, 'lookup')

  const [memberships, lists, logs] = await Promise.all([
    db.studyListItems.where('wordId').equals(wordId).toArray(),
    db.studyLists.toArray(),
    db.reviewLogs.where('wordId').equals(wordId).toArray(),
  ])
  const listMap = new Map(lists.map((list) => [list.listId, list]))
  const learningMemberships = memberships.filter((membership) => listMap.get(membership.listId)?.systemType !== 'lookup')
  if (!learningMemberships.length) throw new Error('请先选择一个学习词表')

  const now = at.toISOString()
  const dayKey = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
  const dailySession = await db.dailyLearningSessions.where('dayKey').equals(dayKey).first()
  const oldQueueItems = dailySession
    ? await db.dailyQueueItems.where('sessionId').equals(dailySession.sessionId).filter((row) => row.wordId === wordId).toArray()
    : []
  const oldQueueAttempts = dailySession
    ? await db.dailyQueueAttempts.where('[sessionId+wordId]').equals([dailySession.sessionId, wordId]).toArray()
    : []
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

  let newQueueItem: import('../../types/models').DailyQueueItem | undefined
  let updatedSession: import('../../types/models').DailyLearningSession | undefined
  let reorderedPending: import('../../types/models').DailyQueueItem[] = []
  if (dailySession?.status === 'active' && dailySession.phase === 'cards') {
    const oldIds = new Set(oldQueueItems.map((row) => row.itemId))
    const pending = (await db.dailyQueueItems.where('sessionId').equals(dailySession.sessionId).sortBy('position'))
      .filter((row) => !oldIds.has(row.itemId) && (row.status === 'pending' || row.status === 'active'))
    newQueueItem = {
      itemId: `${dailySession.sessionId}:reencounter:${wordId}:${crypto.randomUUID()}`,
      sessionId: dailySession.sessionId,
      kind: 'card',
      wordId,
      reason: 'reencounter',
      position: Math.min(2, pending.length),
      status: 'pending',
      attemptNo: 1,
      maxAttempts: 5,
      retrievability: 0,
      startingLongTermRetrievability: 0,
      wasNew: true,
      todayMastery: 0,
      recallStreak: 0,
      weakSeen: false,
      attemptCount: 0,
      nextGap: 0,
      tomorrowPriority: false,
      createdAt: now,
      updatedAt: now,
    }
    pending.splice(Math.min(2, pending.length), 0, newQueueItem)
    reorderedPending = pending.map((row, position) => ({ ...row, position, updatedAt: now }))
    updatedSession = {
      ...dailySession,
      status: 'active',
      phase: 'cards',
      initialWordIds: [...new Set([...dailySession.initialWordIds, wordId])],
      cardsCompletedAt: undefined,
      articleStatus: dailySession.articleStatus === 'ready' || dailySession.articleStatus === 'generating' || dailySession.articleStatus === 'completed'
        ? 'stale'
        : dailySession.articleStatus,
      completedAt: undefined,
      updatedAt: now,
    }
  }

  await db.transaction('rw', [db.wordbook, db.reviewState, db.reviewLogs, db.studyListItems, db.dailyLearningSessions, db.dailyQueueItems, db.dailyQueueAttempts], async () => {
    await db.wordbook.put(refreshedItem)
    await db.reviewState.put(freshState)
    await db.reviewLogs.where('wordId').equals(wordId).delete()
    await db.studyListItems.bulkPut(refreshedMemberships)
    if (dailySession) {
      await db.dailyQueueItems.where('sessionId').equals(dailySession.sessionId).filter((row) => row.wordId === wordId).delete()
      await db.dailyQueueAttempts.where('[sessionId+wordId]').equals([dailySession.sessionId, wordId]).delete()
    }
    if (reorderedPending.length) await db.dailyQueueItems.bulkPut(reorderedPending)
    if (updatedSession) await db.dailyLearningSessions.put(updatedSession)
  })

  await markPayloadChanged('wordbook', refreshedItem, now)
  await markRecordChanged('reviewState', wordId, now)
  for (const membership of refreshedMemberships) await markPayloadChanged('studyListItems', membership, now)
  for (const log of logs) await markRecordDeleted('reviewLogs', reviewLogSyncId(log), now)
  for (const row of oldQueueItems) await markRecordDeleted('dailyQueueItems', row.itemId, now)
  for (const row of oldQueueAttempts) await markRecordDeleted('dailyQueueAttempts', row.attemptId, now)
  for (const row of reorderedPending) await markPayloadChanged('dailyQueueItems', row, now)
  if (updatedSession) await markPayloadChanged('dailyLearningSessions', updatedSession, now)
  await markStudyDataChanged()
  invalidateStudyPlanCache()
  emitWordbookUpdatedEvent()
}

export async function removeWordFromWordbook(wordId: string): Promise<void> {
  const [memberships, contextAttempts, queueItems, queueAttempts] = await Promise.all([
    db.studyListItems.where('wordId').equals(wordId).toArray(),
    db.contextAttempts.where('wordId').equals(wordId).toArray(),
    db.dailyQueueItems.where('wordId').equals(wordId).toArray(),
    db.dailyQueueAttempts.where('wordId').equals(wordId).toArray(),
  ])
  await db.transaction(
    'rw',
    [db.wordbook, db.reviewState, db.reviewLogs, db.studyListItems, db.contextAttempts, db.dailyQueueItems, db.dailyQueueAttempts, db.syncMeta, db.syncRecords, db.syncTombstones],
    async () => {
      const deletedAt = new Date().toISOString()
      const logs = await db.reviewLogs.where('wordId').equals(wordId).toArray()
      await db.wordbook.delete(wordId)
      await db.reviewState.delete(wordId)
      await db.reviewLogs.where('wordId').equals(wordId).delete()
      await db.studyListItems.where('wordId').equals(wordId).delete()
      await db.contextAttempts.where('wordId').equals(wordId).delete()
      await db.dailyQueueItems.where('wordId').equals(wordId).delete()
      await db.dailyQueueAttempts.where('wordId').equals(wordId).delete()
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
