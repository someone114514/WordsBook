import { db } from '../../db/database'
import type { AddToWordbookResult, WordbookItem, WordbookWithEntry } from '../../types/models'
import { applyAiOverrides } from '../dictionary/entryOverrideMapper'
import { invalidateStudyPlanCache } from '../review/reviewService'

export async function listWordbookItems(): Promise<WordbookWithEntry[]> {
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
      const entry = entryMap.get(item.entryId)
      if (!entry) {
        return undefined
      }

      return {
        item,
        entry,
        reviewState: stateRows[index] ?? undefined,
      }
    })
    .filter((value): value is WordbookWithEntry => value !== undefined)
}

export async function addToWordbook(entryId: string): Promise<AddToWordbookResult> {
  const existing = await db.wordbook.where('entryId').equals(entryId).first()
  if (existing) {
    return { wordId: existing.wordId, alreadyExists: true }
  }

  const now = new Date().toISOString()
  const wordId = crypto.randomUUID()

  const item: WordbookItem = {
    wordId,
    entryId,
    addedAt: now,
    note: '',
    tags: [],
    archived: 0,
  }

  await db.transaction('rw', db.wordbook, db.reviewState, async () => {
    await db.wordbook.put(item)
    await db.reviewState.put({
      wordId,
      cycle: 0,
      nextReviewAt: now,
      successCount: 0,
      lapseCount: 0,
      totalReviews: 0,
    })
  })
  invalidateStudyPlanCache()

  return { wordId, alreadyExists: false }
}

export async function removeWordFromWordbook(wordId: string): Promise<void> {
  await db.transaction('rw', db.wordbook, db.reviewState, db.reviewLogs, async () => {
    await db.wordbook.delete(wordId)
    await db.reviewState.delete(wordId)
    await db.reviewLogs.where('wordId').equals(wordId).delete()
  })
  invalidateStudyPlanCache()
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
  if (patch.archived !== undefined) {
    invalidateStudyPlanCache()
  }
  return next
}

export async function getWordbookEntryStatus(entryIds: string[]): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(entryIds)]
  if (uniqueIds.length === 0) {
    return new Map<string, string>()
  }

  const rows = await db.wordbook.where('entryId').anyOf(uniqueIds).toArray()
  return new Map(rows.map((row) => [row.entryId, row.wordId]))
}

export async function getWordbookStats(): Promise<{ total: number; active: number }> {
  const total = await db.wordbook.count()
  const active = await db.wordbook.where('archived').equals(0).count()
  return { total, active }
}
