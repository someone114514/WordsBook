import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../db/database'
import { buildTodayPlan, buildTodayPlanCached, invalidateStudyPlanCache } from '../review/reviewService'
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
    invalidateStudyPlanCache()
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
    const plan = await buildTodayPlan({ listIds: [second.listId], dailyNewLimit: 20, dailyReviewLimit: 20 })
    expect(plan.queueWordIds).toEqual([item.wordId])
    expect(plan.dueCount + plan.newCount).toBe(plan.queueWordIds.length)
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

  it('respects a zero new-word limit without forcing a fallback card', async () => {
    const entry = { entryId: 'entry:limited', headword: 'limited', headwordLower: 'limited', posList: [], sensesJson: '[]', examplesJson: '[]', usageJson: '[]' }
    const { item } = await ensureVocabularyItem(entry)
    const list = await createStudyList('Limited')
    await addWordToStudyList(list.listId, item.wordId)

    const plan = await buildTodayPlan({ dailyNewLimit: 0, dailyReviewLimit: 20 })
    expect(plan.queueWordIds).toEqual([])
    expect(plan.newCount).toBe(0)
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

  it('prioritizes a lookup-added new word ahead of a later bulk-import word', async () => {
    const list = await createStudyList('Priority')
    const imported = await ensureVocabularyItem({ entryId: 'entry:imported', headword: 'imported', headwordLower: 'imported', posList: [], sensesJson: '[]', examplesJson: '[]', usageJson: '[]' })
    const lookedUp = await ensureVocabularyItem({ entryId: 'entry:lookedup', headword: 'lookedup', headwordLower: 'lookedup', posList: [], sensesJson: '[]', examplesJson: '[]', usageJson: '[]' })
    await addWordToStudyList(list.listId, imported.item.wordId, 'import')
    await addWordToStudyList(list.listId, lookedUp.item.wordId, 'lookup')
    const plan = await buildTodayPlan({ dailyNewLimit: 1, dailyReviewLimit: 20 })
    expect(plan.queueWordIds).toEqual([lookedUp.item.wordId])
  })

  it('reuses the daily plan until study data actually changes', async () => {
    const list = await createStudyList('Cached')
    const firstWord = await ensureVocabularyItem({ entryId: 'entry:first', headword: 'first', headwordLower: 'first', posList: [], sensesJson: '[]', examplesJson: '[]', usageJson: '[]' })
    await addWordToStudyList(list.listId, firstWord.item.wordId, 'lookup')
    const first = await buildTodayPlanCached()
    expect(await buildTodayPlanCached()).toBe(first)

    const secondWord = await ensureVocabularyItem({ entryId: 'entry:second', headword: 'second', headwordLower: 'second', posList: [], sensesJson: '[]', examplesJson: '[]', usageJson: '[]' })
    await addWordToStudyList(list.listId, secondWord.item.wordId, 'lookup')
    const changed = await buildTodayPlanCached()
    expect(changed).not.toBe(first)
    expect(changed.queueWordIds).toContain(secondWord.item.wordId)
  })
})
