import { db } from '../../db/database'
import type { AddToWordbookResult, WordbookItem, WordbookWithEntry } from '../../types/models'
import { applyAiOverrides } from '../dictionary/entryOverrideMapper'
import { invalidateStudyPlanCache } from '../review/reviewService'
import { dictionaryEntryFromWordbook, repairVocabularyIntegrity, snapshotDictionaryEntry, unresolvedVocabularyEntry } from './vocabularyIntegrity'
import { addWordToStudyList, ensureSystemStudyLists, LOOKUP_LIST_ID, removeWordFromStudyList } from './studyListService'
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
    await addWordToStudyList(LOOKUP_LIST_ID, existing.wordId)
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
  await addWordToStudyList(LOOKUP_LIST_ID, wordId)
  emitWordbookUpdatedEvent()

  return { wordId, alreadyExists: false }
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
