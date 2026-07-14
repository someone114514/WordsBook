import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../db/database'
import { buildTodayPlan } from '../review/reviewService'
import { getWordbookEntryStatus, removeFromLookupCollection } from './wordbookService'
import {
  LOOKUP_LIST_ID,
  addWordToStudyList,
  createStudyList,
  ensureVocabularyItem,
  updateStudyList,
} from './studyListService'

describe('study list membership', () => {
  beforeEach(async () => {
    db.close()
    await db.delete()
    await db.open()
  })

  it('deduplicates one word across lists while keeping one review state', async () => {
    const entry = { entryId: 'entry:one', headword: 'one', headwordLower: 'one', posList: ['number'], sensesJson: '["一"]', examplesJson: '[]', usageJson: '[]' }
    await db.dictionaryEntries.put(entry)
    const { item } = await ensureVocabularyItem(entry)
    const first = await createStudyList('First')
    const second = await createStudyList('Second')
    expect(await addWordToStudyList(first.listId, item.wordId)).toBe(true)
    expect(await addWordToStudyList(first.listId, item.wordId)).toBe(false)
    expect(await addWordToStudyList(second.listId, item.wordId)).toBe(true)
    expect(await db.wordbook.count()).toBe(1)
    expect(await db.reviewState.count()).toBe(1)
    expect((await buildTodayPlan({ listIds: [second.listId], dailyNewLimit: 20, dailyReviewLimit: 20 })).queueWordIds).toEqual([item.wordId])
  })

  it('keeps lookup-only words out of the global study plan', async () => {
    const entry = { entryId: 'entry:saved', headword: 'saved', headwordLower: 'saved', posList: [], sensesJson: '[]', examplesJson: '[]', usageJson: '[]' }
    await db.dictionaryEntries.put(entry)
    const { item } = await ensureVocabularyItem(entry)
    await addWordToStudyList(LOOKUP_LIST_ID, item.wordId)
    const enabled = await createStudyList('Temporary')
    await updateStudyList(enabled.listId, { studyEnabled: 0 })
    expect((await buildTodayPlan({ dailyNewLimit: 20, dailyReviewLimit: 20 })).queueWordIds).toEqual([])
  })

  it('distinguishes learning membership from save-only membership', async () => {
    const entry = { entryId: 'entry:status', headword: 'status', headwordLower: 'status', posList: ['noun'], sensesJson: '["状态"]', examplesJson: '[]', usageJson: '[]' }
    const { item } = await ensureVocabularyItem(entry)
    const list = await createStudyList('Learning')
    await addWordToStudyList(LOOKUP_LIST_ID, item.wordId)
    await addWordToStudyList(list.listId, item.wordId)
    expect((await getWordbookEntryStatus([entry.entryId])).get(entry.entryId)?.listIds).toEqual(expect.arrayContaining([LOOKUP_LIST_ID, list.listId]))

    await removeFromLookupCollection(item.wordId)
    expect(await db.wordbook.get(item.wordId)).toBeDefined()
    expect((await getWordbookEntryStatus([entry.entryId])).get(entry.entryId)?.listIds).toEqual([list.listId])

    const savedOnly = await ensureVocabularyItem({ ...entry, entryId: 'entry:saved-only', headword: 'savedonly', headwordLower: 'savedonly' })
    await addWordToStudyList(LOOKUP_LIST_ID, savedOnly.item.wordId)
    await removeFromLookupCollection(savedOnly.item.wordId)
    expect(await db.wordbook.get(savedOnly.item.wordId)).toBeUndefined()
  })

  it('strips reactive array proxies before writing a looked-up entry', async () => {
    const reactivePosList = new Proxy(['noun'], {})
    const entry = { entryId: 'entry:proxy', headword: 'proxy', headwordLower: 'proxy', posList: reactivePosList, sensesJson: '["代理"]', examplesJson: '[]', usageJson: '[]' }
    const { item } = await ensureVocabularyItem(entry)
    expect((await db.wordbook.get(item.wordId))?.entrySnapshot?.posList).toEqual(['noun'])
  })
})
