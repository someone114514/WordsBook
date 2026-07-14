import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../db/database'
import { dictionaryEntryFromWordbook, repairVocabularyIntegrity } from './vocabularyIntegrity'

describe('vocabulary referential integrity', () => {
  beforeEach(async () => { db.close(); await db.delete(); await db.open() })

  it('relinks an ecdict-full word to the current package without changing wordId', async () => {
    await db.dictionaryEntries.put({ entryId: 'ecdict-core:ecdict:resilient', headword: 'resilient', headwordLower: 'resilient', phonetic: 'rɪˈzɪliənt', posList: ['adj'], sensesJson: '["有韧性的"]', examplesJson: '[]', usageJson: '[]' })
    await db.wordbook.put({ wordId: 'stable-word-id', entryId: 'ecdict-full:ecdict:resilient', addedAt: new Date().toISOString(), note: '', tags: [], archived: 0 })
    const report = await repairVocabularyIntegrity(['stable-word-id'])
    const repaired = await db.wordbook.get('stable-word-id')
    expect(report).toEqual({ repaired: 1, unresolved: 0 })
    expect(repaired?.entryId).toBe('ecdict-core:ecdict:resilient')
    expect(repaired?.headword).toBe('resilient')
    expect(repaired?.entrySnapshot?.sensesJson).toBe('["有韧性的"]')
  })

  it('uses a stable snapshot and never turns a uuid into a headword', async () => {
    const uuid = 'd7d467fe-fd5e-48e7-81c8-e64b242c8a9b'
    await db.wordbook.put({ wordId: uuid, entryId: uuid, addedAt: new Date().toISOString(), note: '', tags: [], archived: 0 })
    expect(await repairVocabularyIntegrity([uuid])).toEqual({ repaired: 0, unresolved: 1 })
    expect(dictionaryEntryFromWordbook((await db.wordbook.get(uuid))!)).toBeUndefined()
    expect((await db.wordbook.get(uuid))?.integrityStatus).toBe('needs-repair')
  })
})
