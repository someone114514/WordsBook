import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../db/database'
import type { ReadingTarget, ReviewLog } from '../../types/models'
import { appendOmittedReadingTargets, buildReadingTargetBatches, generateReadingSession, getOrCreateReadingBatches, groupReadingSegmentsByParagraph, listReadingHistory, readingBatchRangeForRound, recordContextAttempt, resetReadingSessionAttempts, saveReadingProgress, sortTargetsByPassageOrder } from './readingService'

function log(wordId: string, rating: ReviewLog['rating'], wasNew = false): ReviewLog {
  return {
    wordId, rating, wasNew, source: 'flashcard', reviewedAt: '2026-07-13T08:00:00.000Z',
    cycleBefore: 0, cycleAfter: 0, nextReviewAtBefore: '2026-07-13T08:00:00.000Z',
    nextReviewAtAfter: '2026-07-14T08:00:00.000Z',
  }
}

function articleStream(input: {
  title: string
  paragraphs: string[]
  targets?: ReadingTarget[]
  translation: string
}): Response {
  const events = [
    JSON.stringify({ type: 'meta', title: input.title }),
    ...input.paragraphs.map((text) => JSON.stringify({ type: 'paragraph', text })),
    ...(input.targets ?? []).map((target) => JSON.stringify({ type: 'target', ...target })),
    JSON.stringify({ type: 'translation', text: input.translation }),
    JSON.stringify({ type: 'done' }),
  ].join('\n')
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: `${events}\n` } }] })}\n\n`)
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
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(articleStream({ title: '', paragraphs: ['She stayed calm.'], translation: '她保持冷静。' }))
      .mockResolvedValueOnce(articleStream({
        title: 'A Test',
        paragraphs: ['She stayed resilient.'],
        targets: [{ wordId: 'w1', headword: 'resilient', contextualMeaning: '有韧性的', choices: ['有韧性的', '迟缓的', '安静的'], explanation: '面对困难仍能恢复。' }],
        translation: '她保持坚韧。',
      }))
    vi.stubGlobal('fetch', fetchMock)
    const staleWordId = 'd7d467fe-fd5e-48e7-81c8-e64b242c8a9b'
    const streamed: string[] = []
    const session = await generateReadingSession({ dayKey: '2026-07-13', batchIndex: 0, seed: 9, wordIds: ['w1', staleWordId], level: 'B2', onProgress: (progress) => streamed.push(progress.rawText) })
    expect(session.status).toBe('ready')
    expect(session.targetWordIds).toEqual(['w1'])
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).not.toContain(staleWordId)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(streamed.some((text) => text.includes('resilient'))).toBe(true)
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain('allowedSenses')
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain('有韧性的')
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).response_format).toBeUndefined()
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high' })
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).temperature).toBeUndefined()
    expect((await db.readingSessions.get(session.sessionId))?.title).toBe('A Test')
  })

  it('rejects near-synonym distractors and never exposes an internal uuid', async () => {
    await db.localSecrets.put({ key: 'deepseekApiKey', value: 'test-key' })
    await db.settings.bulkPut([{ key: 'deepseekBaseUrl', value: 'https://example.test/chat' }, { key: 'deepseekModel', value: 'test-model' }])
    await db.dictionaryEntries.put({ entryId: 'core:marker', headword: 'marker', headwordLower: 'marker', posList: ['n'], sensesJson: '["标记物"]', examplesJson: '[]', usageJson: '[]' })
    await db.wordbook.put({ wordId: 'stable-marker-id', entryId: 'core:marker', headword: 'marker', headwordLower: 'marker', addedAt: '2026-07-13T00:00:00.000Z', note: '', tags: [], archived: 0 })
    const fetchMock = vi.fn().mockResolvedValueOnce(articleStream({
      title: 'Markers',
      paragraphs: ['A marker showed the path.'],
      targets: [{ wordId: 'stable-marker-id', headword: 'marker', contextualMeaning: '标记物', choices: ['标记物', '标记的物体', '安静地点'], explanation: '用于指示位置。' }],
      translation: '一个标记物指出了道路。',
    }))
    vi.stubGlobal('fetch', fetchMock)
    const session = await generateReadingSession({ dayKey: '2026-07-13', batchIndex: 1, seed: 0, wordIds: ['stable-marker-id'], level: 'B2' })
    expect(session.status).toBe('ready')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(session.segmentsJson).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)
  })

  it('keeps a valid streamed article and creates local fallback questions when details fail', async () => {
    await db.localSecrets.put({ key: 'deepseekApiKey', value: 'test-key' })
    await db.settings.bulkPut([{ key: 'deepseekBaseUrl', value: 'https://example.test/chat' }, { key: 'deepseekModel', value: 'test-model' }])
    await db.dictionaryEntries.put({ entryId: 'e1', headword: 'resilient', headwordLower: 'resilient', posList: ['adj'], sensesJson: '["有韧性的"]', examplesJson: '[]', usageJson: '[]' })
    await db.wordbook.put({ wordId: 'w1', entryId: 'e1', addedAt: '2026-07-13T00:00:00.000Z', note: '', tags: [], archived: 0 })
    const fetchMock = vi.fn().mockResolvedValueOnce(articleStream({
      title: 'Context Reading',
      paragraphs: ['She stayed resilient.'],
      translation: '她保持坚韧。',
    }))
    vi.stubGlobal('fetch', fetchMock)

    const session = await generateReadingSession({ dayKey: '2026-07-13', batchIndex: 2, seed: 0, wordIds: ['w1'] })
    expect(session.status).toBe('ready')
    expect(session.generationAttemptCount).toBe(1)
    expect(session.successfulGenerationCount).toBe(1)
    expect(session.segmentsJson).toContain('resilient')
    expect(session.title).toBe('Context Reading')
    expect(JSON.parse(session.targetsJson)).toEqual([expect.objectContaining({ wordId: 'w1', headword: 'resilient' })])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps a usable article and quizzes when only a small number of words are omitted', async () => {
    await db.localSecrets.put({ key: 'deepseekApiKey', value: 'test-key' })
    await db.settings.bulkPut([{ key: 'deepseekBaseUrl', value: 'https://example.test/chat' }, { key: 'deepseekModel', value: 'test-model' }])
    const vocabulary: Array<[string, string, string]> = [['w1', 'resilient', '有韧性的'], ['w2', 'tranquil', '宁静的'], ['w3', 'vivid', '生动的'], ['w4', 'scarce', '稀缺的'], ['w5', 'brief', '简短的']]
    for (const [wordId, headword, meaning] of vocabulary) {
      await db.dictionaryEntries.put({ entryId: `e-${wordId}`, headword, headwordLower: headword, posList: ['adj'], sensesJson: JSON.stringify([meaning]), examplesJson: '[]', usageJson: '[]' })
      await db.wordbook.put({ wordId, entryId: `e-${wordId}`, addedAt: '2026-07-13T00:00:00.000Z', note: '', tags: [], archived: 0 })
    }
    const targets: ReadingTarget[] = [
      { wordId: 'w1', headword: 'resilient', contextualMeaning: '有韧性的', choices: ['有韧性的', '潮湿的', '昂贵的'], explanation: '上下文释义。' },
      { wordId: 'w3', headword: 'vivid', contextualMeaning: '生动的', choices: ['生动的', '生动描述', '很生动的'], explanation: '上下文释义。' },
      { wordId: 'w4', headword: 'scarce', contextualMeaning: '稀缺的', choices: ['稀缺的', '笔直的', '喧闹的'], explanation: '上下文释义。' },
      { wordId: 'w5', headword: 'brief', contextualMeaning: '简短的', choices: ['简短的', '透明的', '坚硬的'], explanation: '上下文释义。' },
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(articleStream({
      title: 'Water',
      paragraphs: ['A resilient guide gave a vivid and brief account of the scarce water.'],
      targets,
      translation: '一位坚韧的向导生动而简短地讲述了稀缺的水。',
    })))
    const session = await generateReadingSession({ dayKey: '2026-07-13', batchIndex: 3, seed: 0, wordIds: ['w1', 'w2', 'w3', 'w4', 'w5'] })
    expect(session.status).toBe('ready')
    expect(session.targetWordIds).toEqual(['w1', 'w3', 'w5', 'w4'])
    expect(session.omittedTargetWordIds).toEqual(['w2'])
    expect(JSON.parse(session.targetsJson)).toHaveLength(4)
  })

  it('persists the reading batch plan when omitted targets are carried forward', async () => {
    const now = '2026-07-13T08:00:00.000Z'
    await db.dailyLearningSessions.put({
      sessionId: 'daily:2026-07-13', dayKey: '2026-07-13', status: 'active', phase: 'article',
      selectedListIds: [], initialWordIds: ['w1', 'w2', 'w3'], articleStatus: 'ready',
      readingBatchesJson: JSON.stringify([['w1'], ['w2']]), activeReadingBatchIndex: 0,
      createdAt: now, updatedAt: now,
    })

    await appendOmittedReadingTargets('daily:2026-07-13', 0, ['w3'])

    expect(await getOrCreateReadingBatches('daily:2026-07-13', '2026-07-13')).toEqual([['w1'], ['w3', 'w2']])
    expect((await db.dailyLearningSessions.get('daily:2026-07-13'))?.activeReadingBatchIndex).toBe(0)
  })

  it('groups persisted rounds using the configured article interval', async () => {
    const now = '2026-07-13T08:00:00.000Z'
    await db.settings.put({ key: 'articleEveryRounds', value: 3 })
    await db.dailyLearningSessions.put({
      sessionId: 'daily:2026-07-13', dayKey: '2026-07-13', status: 'active', phase: 'article',
      selectedListIds: [], initialWordIds: ['w1', 'w2', 'w3', 'w4'], articleStatus: 'waiting',
      roundsJson: JSON.stringify([
        { index: 1, wordIds: ['w1'] },
        { index: 2, wordIds: ['w2'] },
        { index: 3, wordIds: ['w3'] },
        { index: 4, wordIds: ['w4'] },
      ]),
      createdAt: now, updatedAt: now,
    })

    expect(await getOrCreateReadingBatches('daily:2026-07-13', '2026-07-13')).toEqual([['w1', 'w2', 'w3'], ['w4']])
  })

  it('splits an oversized round group instead of dropping article targets', async () => {
    const now = '2026-07-13T08:00:00.000Z'
    const wordIds = Array.from({ length: 15 }, (_, index) => `w${index + 1}`)
    await db.settings.put({ key: 'articleEveryRounds', value: 3 })
    await db.dailyLearningSessions.put({
      sessionId: 'daily:2026-07-13', dayKey: '2026-07-13', status: 'active', phase: 'cards',
      selectedListIds: [], initialWordIds: wordIds, articleStatus: 'waiting',
      roundsJson: JSON.stringify(Array.from({ length: 3 }, (_, index) => ({ index: index + 1, wordIds: wordIds.slice(index * 5, index * 5 + 5) }))),
      createdAt: now, updatedAt: now,
    })

    const batches = await getOrCreateReadingBatches('daily:2026-07-13', '2026-07-13')
    expect(batches.map((batch) => batch.length)).toEqual([12, 3])
    expect(batches.flat()).toEqual(wordIds)
  })

  it('maps later round groups past every split batch from earlier groups', () => {
    const rounds = JSON.stringify([
      { index: 1, wordIds: Array.from({ length: 7 }, (_, index) => `a${index}`) },
      { index: 2, wordIds: Array.from({ length: 6 }, (_, index) => `b${index}`) },
      { index: 3, wordIds: ['c1', 'c2'] },
      { index: 4, wordIds: ['d1', 'd2'] },
    ])
    expect(readingBatchRangeForRound(rounds, 1, 2)).toEqual({ start: 0, end: 1 })
    expect(readingBatchRangeForRound(rounds, 3, 2)).toEqual({ start: 2, end: 2 })
  })

  it('normalizes the order of previously cached article targets on restore', async () => {
    const now = '2026-07-13T08:00:00.000Z'
    const targets: ReadingTarget[] = [
      { wordId: 'w4', headword: 'scarce', contextualMeaning: '稀缺的', choices: ['稀缺的', '甲', '乙'], explanation: '上下文。' },
      { wordId: 'w1', headword: 'resilient', contextualMeaning: '有韧性的', choices: ['有韧性的', '甲', '乙'], explanation: '上下文。' },
      { wordId: 'w5', headword: 'brief', contextualMeaning: '简短的', choices: ['简短的', '甲', '乙'], explanation: '上下文。' },
      { wordId: 'w3', headword: 'vivid', contextualMeaning: '生动的', choices: ['生动的', '甲', '乙'], explanation: '上下文。' },
    ]
    await db.readingSessions.put({
      sessionId: 'reading:2026-07-13:0:4', dayKey: '2026-07-13', batchIndex: 4, selectionSeed: 0, level: 'B2', topic: '',
      targetWordIds: ['w4', 'w1', 'w5', 'w3'], status: 'ready', title: 'Water',
      segmentsJson: JSON.stringify([
        { text: 'A ' },
        { text: 'resilient', wordId: 'w1' },
        { text: ' and ' },
        { text: 'vivid', wordId: 'w3' },
        { text: ', ' },
        { text: 'brief', wordId: 'w5' },
        { text: ' account covered ' },
        { text: 'scarce', wordId: 'w4' },
        { text: ' water.' },
      ]),
      targetsJson: JSON.stringify(targets), translation: '译文', createdAt: now, updatedAt: now,
    })

    const restored = await generateReadingSession({ dayKey: '2026-07-13', batchIndex: 4, seed: 0, wordIds: ['w1', 'w3', 'w4', 'w5'] })

    expect(restored.targetWordIds).toEqual(['w1', 'w3', 'w5', 'w4'])
    expect(JSON.parse(restored.targetsJson).map((target: ReadingTarget) => target.wordId)).toEqual(['w1', 'w3', 'w5', 'w4'])
  })

  it('orders targets by boundary-aware passage matches and keeps paragraph structure', () => {
    const targets: ReadingTarget[] = [
      { wordId: 'art', headword: 'art', contextualMeaning: '艺术', choices: ['艺术', '道路', '食物'], explanation: '' },
      { wordId: 'state', headword: 'state-of-the-art', contextualMeaning: '最先进的', choices: ['最先进的', '潮湿的', '古老的'], explanation: '' },
      { wordId: 'cant', headword: "can't", contextualMeaning: '不能', choices: ['不能', '奔跑', '容器'], explanation: '' },
    ]
    const passage = "A state-of-the-art device can help, but it can’t replace art."
    expect(sortTargetsByPassageOrder(targets, passage).map((target) => target.wordId)).toEqual(['state', 'cant', 'art'])

    const paragraphs = groupReadingSegmentsByParagraph([
      { text: 'First ' }, { text: 'target', wordId: 'art' }, { text: ' paragraph.\n\nSecond paragraph.' },
    ])
    expect(paragraphs).toHaveLength(2)
    expect(paragraphs[0]?.map((segment) => segment.text).join('')).toBe('First target paragraph.')
    expect(paragraphs[1]?.map((segment) => segment.text).join('')).toBe('Second paragraph.')
  })

  it('orders a natural article inflection under its target lemma', () => {
    const targets: ReadingTarget[] = [
      { wordId: 'study', headword: 'study', contextualMeaning: '学习', choices: ['学习', '休息', '旅行'], explanation: '' },
      { wordId: 'run', headword: 'run', contextualMeaning: '跑', choices: ['跑', '读', '写'], explanation: '' },
      { wordId: 'good', headword: 'good', contextualMeaning: '好的', choices: ['好的', '慢的', '远的'], explanation: '' },
    ]
    const passage = 'She studies every day, then ran home feeling better.'
    expect(sortTargetsByPassageOrder(targets, passage, { studies: 'study', ran: 'run', better: 'well|good|better' }).map((target) => target.wordId)).toEqual(['study', 'run', 'good'])
  })

  it('returns a structured error when article generation has no API key', async () => {
    const now = '2026-07-13T00:00:00.000Z'
    await db.dictionaryEntries.put({ entryId: 'e1', headword: 'resilient', headwordLower: 'resilient', posList: ['adj'], sensesJson: '["有韧性的"]', examplesJson: '[]', usageJson: '[]' })
    await db.wordbook.put({ wordId: 'w1', entryId: 'e1', addedAt: now, note: '', tags: [], archived: 0 })
    const session = await generateReadingSession({ dayKey: '2026-07-13', batchIndex: 0, seed: 0, wordIds: ['w1'], level: 'B2' })

    expect(session.status).toBe('failed')
    expect(session.errorCode).toBe('missing-key')
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
