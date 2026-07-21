import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../db/database'
import { enhanceOrCreateVocabularyEntry, fetchAiDictionaryDraft } from './aiDefinitionService'

describe('AI dictionary enhancement', () => {
  beforeEach(async () => {
    db.close()
    await db.delete()
    await db.open()
    vi.restoreAllMocks()
  })

  it('creates an AI-local entry for a snapshot-only imported word without changing learning identity', async () => {
    const now = '2026-07-17T00:00:00.000Z'
    await db.wordbook.put({
      wordId: 'w-imported', entryId: 'missing:quarklet', headword: 'quarklet', headwordLower: 'quarklet',
      entrySnapshot: { headword: 'quarklet', headwordLower: 'quarklet', posList: ['noun'], sensesJson: '["一种专业术语"]', examplesJson: '[]', usageJson: '[]' },
      addedAt: now, note: '', tags: [], archived: 0,
    })
    await db.reviewState.put({ wordId: 'w-imported', cycle: 0, nextReviewAt: now, successCount: 0, lapseCount: 0, totalReviews: 0 })
    await db.dailyQueueItems.put({ itemId: 'i1', sessionId: 'daily:test', kind: 'card', wordId: 'w-imported', reason: 'initial', position: 0, status: 'pending', attemptNo: 1, maxAttempts: 5, retrievability: 0, createdAt: now, updatedAt: now })

    const result = await enhanceOrCreateVocabularyEntry({
      wordId: 'w-imported', entryId: 'missing:quarklet', model: 'test',
      draft: { headword: 'quarklet', posList: ['noun'], senses: ['noun: 一种专业术语'], examples: [], usage: [] },
    })

    expect(result.created).toBe(true)
    expect((await db.wordbook.get('w-imported'))?.entryId).toBe('ai:quarklet')
    expect(await db.reviewState.get('w-imported')).toBeTruthy()
    expect((await db.dailyQueueItems.get('i1'))?.wordId).toBe('w-imported')
  })

  it('retries when the model incorrectly denies an existing imported word', async () => {
    const response = (content: object) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ headword: 'quarklet', posList: ['noun'], senses: ['No such word exists.'], examples: [], usage: [], notes: [] }))
      .mockResolvedValueOnce(response({ headword: 'quarklet', posList: ['noun'], senses: ['noun: 一种专业术语'], examples: ['EN: A quarklet appeared. | ZH: 出现了一个 quarklet。', 'EN: We measured the quarklet. | ZH: 我们测量了这个 quarklet。'], usage: [], notes: ['罕见词'] }))
    vi.stubGlobal('fetch', fetchMock)

    const draft = await fetchAiDictionaryDraft({
      word: 'quarklet', apiKey: 'key', baseUrl: 'https://example.test', model: 'test',
      context: { senses: ['一种专业术语'] },
    })
    expect(draft.senses).toEqual(['noun: 一种专业术语'])
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high' })
  })
})
