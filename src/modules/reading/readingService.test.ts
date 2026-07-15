import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../db/database'
import type { ReadingTarget, ReviewLog } from '../../types/models'
import { buildReadingTargetBatches, generateReadingSession, listReadingHistory, recordContextAttempt, resetReadingSessionAttempts, saveReadingProgress } from './readingService'

function log(wordId: string, rating: ReviewLog['rating'], wasNew = false): ReviewLog {
  return {
    wordId, rating, wasNew, source: 'flashcard', reviewedAt: '2026-07-13T08:00:00.000Z',
    cycleBefore: 0, cycleAfter: 0, nextReviewAtBefore: '2026-07-13T08:00:00.000Z',
    nextReviewAtAfter: '2026-07-14T08:00:00.000Z',
  }
}

describe('reading target selection and context feedback', () => {
  beforeEach(async () => {
    db.close()
    await db.delete()
    await db.open()
  })

  afterEach(() => vi.unstubAllGlobals())

  it('includes every new/hard/again word and only 25% of good-only words', async () => {
    const logs = [log('new', 'good', true), log('hard', 'hard'), log('again', 'again')]
    for (let index = 0; index < 8; index += 1) logs.push(log(`good-${index}`, 'good'))
    logs.push(log('easy', 'easy'))
    await db.reviewLogs.bulkAdd(logs)
    const selected = (await buildReadingTargetBatches('2026-07-13', 0)).flat()
    expect(selected).toEqual(expect.arrayContaining(['new', 'hard', 'again']))
    expect(selected.filter((wordId) => wordId.startsWith('good-'))).toHaveLength(2)
    expect(selected).not.toContain('easy')
  })

  it('does not reward a correct context answer but schedules uncertain words for relearning', async () => {
    const initial = { wordId: 'w1', cycle: 0, nextReviewAt: '2026-07-20T00:00:00.000Z', successCount: 1, lapseCount: 0, totalReviews: 1 }
    await db.reviewState.put(initial)
    await db.dailyLearningSessions.put({ sessionId: 'daily:2026-07-13', dayKey: '2026-07-13', status: 'active', phase: 'article', selectedListIds: [], initialWordIds: ['w1'], articleStatus: 'ready', createdAt: '2026-07-13T00:00:00.000Z', updatedAt: '2026-07-13T00:00:00.000Z' })
    const target: ReadingTarget = { wordId: 'w1', headword: 'word', contextualMeaning: '含义', choices: ['含义', '甲', '乙'], explanation: '上下文' }
    await recordContextAttempt('s1', target, '含义')
    expect((await db.reviewState.get('w1'))?.nextReviewAt).toBe(initial.nextReviewAt)
    await recordContextAttempt('s2', target, undefined, 'daily:2026-07-13')
    expect(await db.dailyQueueItems.where('sessionId').equals('daily:2026-07-13').count()).toBe(1)
    expect((await db.reviewState.get('w1'))?.sameDayRelearnAt).toBeUndefined()
  })

  it('balances large mandatory sets into model-safe batches of no more than 12', async () => {
    await db.reviewLogs.bulkAdd(Array.from({ length: 60 }, (_, index) => log(`new-${index}`, 'good', true)))
    const batches = await buildReadingTargetBatches('2026-07-13', 0)
    expect(batches).toHaveLength(5)
    expect(batches.every((batch) => batch.length === 12)).toBe(true)
  })

  it('retries an invalid AI payload once and caches the validated article', async () => {
    await db.localSecrets.put({ key: 'deepseekApiKey', value: 'test-key' })
    await db.settings.bulkPut([
      { key: 'deepseekBaseUrl', value: 'https://example.test/chat' },
      { key: 'deepseekModel', value: 'test-model' },
    ])
    await db.dictionaryEntries.put({ entryId: 'e1', headword: 'resilient', headwordLower: 'resilient', posList: ['adj'], sensesJson: '["有韧性的"]', examplesJson: '[]', usageJson: '[]' })
    await db.wordbook.put({ wordId: 'w1', entryId: 'e1', addedAt: '2026-07-13T00:00:00.000Z', note: '', tags: [], archived: 0 })
    const passageStream = (article: string) => {
      const json = JSON.stringify({ article })
      const chunks = json.match(/.{1,12}/g) ?? [json]
      return new Response(chunks.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join(''))
    }
    const detailsResponse = new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      title: 'A Test',
      targets: [{ wordId: 'w1', headword: 'resilient', contextualMeaning: '有韧性的', choices: ['有韧性的', '迟缓的', '安静的'], explanation: '面对困难仍能恢复。' }],
      translation: '她保持坚韧。',
    }) } }] }), { headers: { 'Content-Type': 'application/json' } })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(passageStream('She stayed calm.'))
      .mockResolvedValueOnce(passageStream('She stayed resilient.'))
      .mockResolvedValueOnce(detailsResponse)
    vi.stubGlobal('fetch', fetchMock)
    const staleWordId = 'd7d467fe-fd5e-48e7-81c8-e64b242c8a9b'
    const streamed: string[] = []
    const session = await generateReadingSession({ dayKey: '2026-07-13', batchIndex: 0, seed: 9, wordIds: ['w1', staleWordId], level: 'B2', onProgress: (progress) => streamed.push(progress.rawText) })
    expect(session.status).toBe('ready')
    expect(session.targetWordIds).toEqual(['w1'])
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).not.toContain(staleWordId)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(streamed.some((text) => text.includes('resilient'))).toBe(true)
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).response_format).toEqual({ type: 'json_object' })
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)).response_format).toEqual({ type: 'json_object' })
    expect((await db.readingSessions.get(session.sessionId))?.title).toBe('A Test')
  })

  it('rejects near-synonym distractors and never exposes an internal uuid', async () => {
    await db.localSecrets.put({ key: 'deepseekApiKey', value: 'test-key' })
    await db.settings.bulkPut([{ key: 'deepseekBaseUrl', value: 'https://example.test/chat' }, { key: 'deepseekModel', value: 'test-model' }])
    await db.dictionaryEntries.put({ entryId: 'core:marker', headword: 'marker', headwordLower: 'marker', posList: ['n'], sensesJson: '["标记物"]', examplesJson: '[]', usageJson: '[]' })
    await db.wordbook.put({ wordId: 'stable-marker-id', entryId: 'core:marker', headword: 'marker', headwordLower: 'marker', addedAt: '2026-07-13T00:00:00.000Z', note: '', tags: [], archived: 0 })
    const passageJson = JSON.stringify({ article: 'A marker showed the path.' })
    const stream = new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: passageJson } }] })}\n\n`)
    const detailsResponse = (choices: string[]) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: 'Markers', targets: [{ wordId: 'stable-marker-id', headword: 'marker', contextualMeaning: '标记物', choices, explanation: '用于指示位置。' }], translation: '一个标记物指出了道路。' }) } }] }), { headers: { 'Content-Type': 'application/json' } })
    const repairResponse = new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ targets: [{ wordId: 'stable-marker-id', choices: ['标记物', '饮用容器', '交通工具'], explanation: '用于指示位置。' }] }) } }] }), { headers: { 'Content-Type': 'application/json' } })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(stream)
      .mockResolvedValueOnce(detailsResponse(['标记物', '标记的物体', '安静地点']))
      .mockResolvedValueOnce(repairResponse)
    vi.stubGlobal('fetch', fetchMock)
    const session = await generateReadingSession({ dayKey: '2026-07-13', batchIndex: 1, seed: 0, wordIds: ['stable-marker-id'], level: 'B2' })
    expect(session.status).toBe('ready')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(session.segmentsJson).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)
  })

  it('keeps a valid streamed article and creates local fallback questions when details fail', async () => {
    await db.localSecrets.put({ key: 'deepseekApiKey', value: 'test-key' })
    await db.settings.bulkPut([{ key: 'deepseekBaseUrl', value: 'https://example.test/chat' }, { key: 'deepseekModel', value: 'test-model' }])
    await db.dictionaryEntries.put({ entryId: 'e1', headword: 'resilient', headwordLower: 'resilient', posList: ['adj'], sensesJson: '["有韧性的"]', examplesJson: '[]', usageJson: '[]' })
    await db.wordbook.put({ wordId: 'w1', entryId: 'e1', addedAt: '2026-07-13T00:00:00.000Z', note: '', tags: [], archived: 0 })
    const stream = new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ article: 'She stayed resilient.' }) } }] })}\n\n`)
    const invalidDetails = () => new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(stream)
      .mockResolvedValueOnce(invalidDetails())
    vi.stubGlobal('fetch', fetchMock)

    const session = await generateReadingSession({ dayKey: '2026-07-13', batchIndex: 2, seed: 0, wordIds: ['w1'] })
    expect(session.status).toBe('ready')
    expect(session.generationAttemptCount).toBe(1)
    expect(session.successfulGenerationCount).toBe(1)
    expect(session.segmentsJson).toContain('resilient')
    expect(session.title).toBe('Context Reading')
    expect(JSON.parse(session.targetsJson)).toEqual([expect.objectContaining({ wordId: 'w1', headword: 'resilient' })])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('keeps a usable article and quizzes when only a small number of words are omitted', async () => {
    await db.localSecrets.put({ key: 'deepseekApiKey', value: 'test-key' })
    await db.settings.bulkPut([{ key: 'deepseekBaseUrl', value: 'https://example.test/chat' }, { key: 'deepseekModel', value: 'test-model' }])
    const vocabulary: Array<[string, string, string]> = [['w1', 'resilient', '有韧性的'], ['w2', 'tranquil', '宁静的'], ['w3', 'vivid', '生动的'], ['w4', 'scarce', '稀缺的'], ['w5', 'brief', '简短的']]
    for (const [wordId, headword, meaning] of vocabulary) {
      await db.dictionaryEntries.put({ entryId: `e-${wordId}`, headword, headwordLower: headword, posList: ['adj'], sensesJson: JSON.stringify([meaning]), examplesJson: '[]', usageJson: '[]' })
      await db.wordbook.put({ wordId, entryId: `e-${wordId}`, addedAt: '2026-07-13T00:00:00.000Z', note: '', tags: [], archived: 0 })
    }
    const stream = new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ article: 'A resilient guide gave a vivid and brief account of the scarce water.' }) } }] })}\n\n`)
    const details = new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      title: 'Water',
      targets: [
        { wordId: 'w1', headword: 'resilient', contextualMeaning: '有韧性的', choices: ['有韧性的', '潮湿的', '昂贵的'], explanation: '上下文释义。' },
        { wordId: 'w3', headword: 'vivid', contextualMeaning: '生动的', choices: ['生动的', '生动描述', '很生动的'], explanation: '上下文释义。' },
        { wordId: 'w4', headword: 'scarce', contextualMeaning: '稀缺的', choices: ['稀缺的', '笔直的', '喧闹的'], explanation: '上下文释义。' },
        { wordId: 'w5', headword: 'brief', contextualMeaning: '简短的', choices: ['简短的', '透明的', '坚硬的'], explanation: '上下文释义。' },
      ],
      translation: '一位坚韧的向导生动而简短地讲述了稀缺的水。',
    }) } }] }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(stream).mockResolvedValueOnce(details))
    const session = await generateReadingSession({ dayKey: '2026-07-13', batchIndex: 3, seed: 0, wordIds: ['w1', 'w2', 'w3', 'w4', 'w5'] })
    expect(session.status).toBe('ready')
    expect(session.targetWordIds).toEqual(['w1', 'w3', 'w4', 'w5'])
    expect(session.omittedTargetWordIds).toEqual(['w2'])
    expect(JSON.parse(session.targetsJson)).toHaveLength(4)
  })

  it('persists reader progress and clears old answers before regeneration', async () => {
    const now = '2026-07-13T08:00:00.000Z'
    await db.readingSessions.put({ sessionId: 'reading:test', dayKey: '2026-07-13', batchIndex: 0, selectionSeed: 0, level: 'B2', topic: '', targetWordIds: ['w1'], status: 'ready', title: 'Test', segmentsJson: '[{"text":"A word."}]', targetsJson: '[]', translation: '', createdAt: now, updatedAt: now })
    await db.contextAttempts.put({ attemptId: 'reading:test:w1', sessionId: 'reading:test', wordId: 'w1', selectedMeaning: '旧答案', result: 'wrong', answeredAt: now })

    await saveReadingProgress('reading:test', 1, true, 2, 1)
    expect(await listReadingHistory()).toEqual([expect.objectContaining({ sessionId: 'reading:test', readerStage: 1, showTranslation: true, quizCursor: 2, resultCursor: 1 })])
    await resetReadingSessionAttempts('reading:test')
    expect(await db.contextAttempts.where('sessionId').equals('reading:test').count()).toBe(0)
  })
})
