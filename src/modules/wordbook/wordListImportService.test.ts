import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../db/database'
import { createStudyList } from './studyListService'
import { importWordList, parseWordListText } from './wordListImportService'

describe('word list parser', () => {
  beforeEach(async () => {
    db.close()
    await db.delete()
    await db.open()
  })
  it('parses BOM CSV headers, quoted commas and tags', () => {
    const rows = parseWordListText('\uFEFFword,meaning,note,tags\nresilient,"有韧性,能恢复的",重点,"考试;B2"')
    expect(rows).toEqual([{ word: 'resilient', meaning: '有韧性,能恢复的', note: '重点', tags: ['考试', 'B2'] }])
  })

  it('parses headerless TSV and one-word-per-line text', () => {
    expect(parseWordListText('apple\t苹果\nbanana\t香蕉')).toHaveLength(2)
    expect(parseWordListText('apple\nbanana').map((row) => row.word)).toEqual(['apple', 'banana'])
  })

  it('reuses dictionary lemmas, preserves phrases and reports duplicates', async () => {
    await db.dictionaryEntries.put({ entryId: 'dict:cat', headword: 'cat', headwordLower: 'cat', posList: ['noun'], sensesJson: '["猫"]', examplesJson: '[]', usageJson: '[]' })
    const list = await createStudyList('Import')
    const report = await importWordList(list.listId, 'cats\nlook forward to,期待\ncats')
    expect(report.matched).toBe(1)
    expect(report.created).toBe(1)
    expect(report.duplicates).toBe(1)
    expect((await db.dictionaryEntries.get('import:look forward to'))?.headwordLower).toBe('look forward to')
    expect(await db.wordbook.count()).toBe(2)
    expect(await db.reviewState.count()).toBe(2)
  })
})
