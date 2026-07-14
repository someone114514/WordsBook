import { db } from '../../db/database'
import type {
  DictionaryEntry,
  StudyList,
  StudyListItem,
  WordbookItem,
} from '../../types/models'
import { invalidateStudyPlanCache } from '../review/reviewService'
import { markPayloadChanged, markRecordChanged, markRecordDeleted } from '../sync/localSyncStore'
import { dictionaryEntryFromWordbook, snapshotDictionaryEntry, unresolvedVocabularyEntry } from './vocabularyIntegrity'

const LOOKUP_LIST_ID = 'system:lookup'
const LEGACY_LIST_ID = 'system:legacy'

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `list-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export async function ensureSystemStudyLists(): Promise<void> {
  const now = new Date().toISOString()
  const existing = await db.studyLists.bulkGet([LOOKUP_LIST_ID, LEGACY_LIST_ID])
  const missing: StudyList[] = []
  if (!existing[0]) {
    missing.push({
      listId: LOOKUP_LIST_ID,
      name: '仅保存',
      description: '保存但不进入每日学习的单词',
      studyEnabled: 0,
      systemType: 'lookup',
      createdAt: now,
      updatedAt: now,
    })
  }
  if (!existing[1]) {
    missing.push({
      listId: LEGACY_LIST_ID,
      name: '我的单词',
      description: '默认参与每日学习的词表',
      studyEnabled: 1,
      systemType: 'legacy',
      createdAt: now,
      updatedAt: now,
    })
  }
  if (missing.length) {
    await db.studyLists.bulkPut(missing)
    for (const list of missing) await markPayloadChanged('studyLists', list, list.updatedAt)
  }
  const renames: StudyList[] = []
  if (existing[0] && existing[0].name !== '仅保存') renames.push({ ...existing[0], name: '仅保存', description: '保存但不进入每日学习的单词', updatedAt: now })
  if (existing[1] && existing[1].name !== '我的单词') renames.push({ ...existing[1], name: '我的单词', description: '默认参与每日学习的词表', studyEnabled: 1, updatedAt: now })
  if (renames.length) {
    await db.studyLists.bulkPut(renames)
    for (const list of renames) await markPayloadChanged('studyLists', list, now)
  }
}

export async function listStudyLists(): Promise<Array<StudyList & { wordCount: number }>> {
  await ensureSystemStudyLists()
  const [lists, memberships] = await Promise.all([
    db.studyLists.toArray(),
    db.studyListItems.toArray(),
  ])
  const counts = new Map<string, number>()
  for (const row of memberships) counts.set(row.listId, (counts.get(row.listId) ?? 0) + 1)
  return lists
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((list) => ({ ...list, wordCount: counts.get(list.listId) ?? 0 }))
}

export async function createStudyList(name: string, description = ''): Promise<StudyList> {
  const normalized = name.trim()
  if (!normalized) throw new Error('请输入词表名称')
  const now = new Date().toISOString()
  const list: StudyList = {
    listId: createId(),
    name: normalized,
    description: description.trim(),
    studyEnabled: 1,
    createdAt: now,
    updatedAt: now,
  }
  await db.studyLists.add(list)
  await markPayloadChanged('studyLists', list, now)
  invalidateStudyPlanCache()
  return list
}

export async function updateStudyList(
  listId: string,
  patch: Partial<Pick<StudyList, 'name' | 'description' | 'studyEnabled'>>,
): Promise<StudyList> {
  const current = await db.studyLists.get(listId)
  if (!current) throw new Error('词表不存在')
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() }
  await db.studyLists.put(next)
  await markPayloadChanged('studyLists', next, next.updatedAt)
  invalidateStudyPlanCache()
  return next
}

export async function deleteStudyList(listId: string): Promise<void> {
  const list = await db.studyLists.get(listId)
  if (!list) return
  if (list.systemType) throw new Error('系统词表不能删除')
  const memberships = await db.studyListItems.where('listId').equals(listId).toArray()
  await db.transaction('rw', [db.studyLists, db.studyListItems], async () => {
    await db.studyListItems.where('listId').equals(listId).delete()
    await db.studyLists.delete(listId)
  })
  await markRecordDeleted('studyLists', listId)
  for (const membership of memberships) await markRecordDeleted('studyListItems', membership.membershipId)
  invalidateStudyPlanCache()
}

export async function ensureVocabularyItem(
  entry: DictionaryEntry,
  note = '',
  tags: string[] = [],
): Promise<{ item: WordbookItem; created: boolean }> {
  // Vue may pass a deeply reactive DictionaryEntry from the lookup view.
  // IndexedDB cannot clone Proxy-backed arrays, so persist a plain boundary object.
  const persistedEntry: DictionaryEntry = {
    ...entry,
    posList: [...entry.posList],
  }
  if (!(await db.dictionaryEntries.get(persistedEntry.entryId))) {
    await db.dictionaryEntries.put(persistedEntry)
    await markPayloadChanged('dictionaryEntries', persistedEntry)
  }
  const existing = await db.wordbook.where('entryId').equals(persistedEntry.entryId).first()
    ?? await db.wordbook.where('headwordLower').equals(persistedEntry.headwordLower).first()
  if (existing) {
    const updated: WordbookItem = {
      ...existing,
      entryId: persistedEntry.entryId,
      headword: persistedEntry.headword,
      headwordLower: persistedEntry.headwordLower,
      entrySnapshot: snapshotDictionaryEntry(persistedEntry),
      integrityStatus: 'ready',
      note: existing.note || note,
      tags: [...new Set([...existing.tags, ...tags])],
      archived: 0,
    }
    if (JSON.stringify(updated) !== JSON.stringify(existing)) {
      await db.wordbook.put(updated)
      await markPayloadChanged('wordbook', updated)
    }
    return { item: updated, created: false }
  }
  const now = new Date().toISOString()
  const item: WordbookItem = {
    wordId: crypto.randomUUID(),
    entryId: persistedEntry.entryId,
    headword: persistedEntry.headword,
    headwordLower: persistedEntry.headwordLower,
    entrySnapshot: snapshotDictionaryEntry(persistedEntry),
    integrityStatus: 'ready',
    addedAt: now,
    note,
    tags,
    archived: 0,
  }
  await db.transaction('rw', [db.wordbook, db.reviewState], async () => {
    await db.wordbook.add(item)
    await db.reviewState.add({
      wordId: item.wordId,
      cycle: 0,
      nextReviewAt: now,
      successCount: 0,
      lapseCount: 0,
      totalReviews: 0,
    })
  })
  await markPayloadChanged('wordbook', item, now)
  await markRecordChanged('reviewState', item.wordId, now)
  return { item, created: true }
}

export async function addWordToStudyList(listId: string, wordId: string): Promise<boolean> {
  const membershipId = `${listId}:${wordId}`
  if (await db.studyListItems.get(membershipId)) return false
  const row: StudyListItem = {
    membershipId,
    listId,
    wordId,
    addedAt: new Date().toISOString(),
  }
  await db.studyListItems.add(row)
  await markPayloadChanged('studyListItems', row, row.addedAt)
  invalidateStudyPlanCache()
  return true
}

export async function addEntryToStudyList(listId: string, entry: DictionaryEntry): Promise<string> {
  const { item } = await ensureVocabularyItem(entry)
  await addWordToStudyList(listId, item.wordId)
  return item.wordId
}

export async function removeWordFromStudyList(listId: string, wordId: string): Promise<void> {
  const membershipId = `${listId}:${wordId}`
  await db.studyListItems.delete(membershipId)
  await markRecordDeleted('studyListItems', membershipId)
  invalidateStudyPlanCache()
}

export async function listStudyListWords(listId: string) {
  const memberships = await db.studyListItems.where('listId').equals(listId).toArray()
  const items = await db.wordbook.bulkGet(memberships.map((row) => row.wordId))
  const words = items.filter((row): row is WordbookItem => Boolean(row))
  const entries = await db.dictionaryEntries.bulkGet(words.map((row) => row.entryId))
  return words.map((item, index) => ({ item, entry: entries[index] ?? dictionaryEntryFromWordbook(item) ?? unresolvedVocabularyEntry(item) }))
}

export { LOOKUP_LIST_ID }
