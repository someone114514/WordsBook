import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../db/database'
import type { ReadingTarget, ReviewLog } from '../../types/models'
import { appendOmittedReadingTargets, buildReadingTargetBatches, generateReadingSession, getOrCreateReadingBatches, groupReadingSegmentsByParagraph, listReadingHistory, readingBatchRangeForRound, readingSessionMatchesBatch, recordContextAttempt, resetReadingSessionAttempts, saveReadingProgress, sortTargetsByPassageOrder } from './readingService'

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
    ...(input.targets ?? []).map((target) => JSON.stringify({
      type: 'target',
      sourceSense: target.sourceSense ?? target.contextualMeaning,
      ...target,
    })),
    JSON.stringify({ type: 'translation', text: input.translation }),
    JSON.stringify({ type: 'done' }),
  ].join('\n')
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: `${events}\n` } }] })}\n\n`)
}

function jsonCompletion(content: object): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }))
}

describe('reading target selection and context feedback', () => {
  beforeEach(async () => {
    db.close()
    await db.delete()
    await db.open()
    await db.settings.put({ key: 'definitionLanguage', value: 'chinese-first' })
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

  it('commits a repeated context submission once with one activity increment and one retry', async () => {
    const now = '2026-07-13T08:00:00.000Z'
    await db.reviewState.put({
      wordId: 'w1',
      cycle: 0,
      nextReviewAt: now,
      successCount: 1,
      lapseCount: 0,
      totalReviews: 1,
    })
    await db.dailyLearningSessions.put({
      sessionId: 'daily:atomic',
      dayKey: '2026-07-13',
      status: 'active',
      phase: 'article',
      engineVersion: 2,
      sessionRevision: 1,
      activityOrdinal: 0,
      selectedListIds: [],
      initialWordIds: ['w1'],
      unitsJson: '[]',
      articleStatus: 'ready',
      createdAt: now,
      updatedAt: now,
    })
    const target: ReadingTarget = {
      wordId: 'w1',
      headword: 'word',
      contextualMeaning: '含义',
      choices: ['含义', '甲', '乙'],
      explanation: '上下文',
    }

    await Promise.all([
      recordContextAttempt('reading:atomic', target, undefined, 'daily:atomic'),
      recordContextAttempt('reading:atomic', target, undefined, 'daily:atomic'),
    ])

    expect(await db.contextAttempts.where('wordId').equals('w1').count()).toBe(1)
    expect(await db.dailyQueueItems.where('sessionId').equals('daily:atomic').count()).toBe(1)
    expect((await db.dailyLearningSessions.get('daily:atomic'))?.activityOrdinal).toBe(1)
  })

  it('balances large mandatory sets into model-safe batches of no more than 12', async () => {
    await db.reviewLogs.bulkAdd(Array.from({ length: 60 }, (_, index) => log(`new-${index}`, 'good', true)))
    const batches = await buildReadingTargetBatches('2026-07-13', 0)
    expect(batches).toHaveLength(5)
    expect(batches.every((batch) => batch.length <= 12)).toBe(true)
    expect(batches.flat()).toHaveLength(60)
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
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain('For this 1-target batch')
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain('one or two paragraph objects')
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).response_format).toBeUndefined()
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high' })
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).temperature).toBeUndefined()
    expect((await db.readingSessions.get(session.sessionId))?.title).toBe('A Test')
  })

  it('keeps distinct English definition choices that share common opening words', async () => {
    await db.localSecrets.put({ key: 'deepseekApiKey', value: 'test-key' })
    await db.settings.bulkPut([
      { key: 'deepseekBaseUrl', value: 'https://example.test/chat' },
      { key: 'deepseekModel', value: 'test-model' },
      { key: 'definitionLanguage', value: 'english-first' },
    ])
    await db.dictionaryEntries.put({
      entryId: 'e1',
      headword: 'resilient',
      headwordLower: 'resilient',
      posList: ['adj'],
      sensesJson: '["有韧性的"]',
      examplesJson: '[]',
      usageJson: '[]',
      senseRecordsJson: JSON.stringify([{
        senseId: 's1',
        pos: 'adj',
        definitionEn: 'able to recover quickly',
        glossZh: '有韧性的',
        examples: [],
      }]),
    })
    await db.wordbook.put({ wordId: 'w1', entryId: 'e1', addedAt: '2026-07-13T00:00:00.000Z', note: '', tags: [], archived: 0 })
    const fetchMock = vi.fn().mockResolvedValueOnce(articleStream({
      title: 'Recovery',
      paragraphs: ['The resilient team recovered after the setback.'],
      targets: [{
        wordId: 'w1',
        headword: 'resilient',
        sourceSense: 'able to recover quickly',
        contextualMeaning: 'able to recover quickly',
        choices: ['able to recover quickly', 'able to remain hidden', 'able to dissolve in water'],
        explanation: 'The team recovered after difficulty.',
      }],
      translation: '这支有韧性的队伍在挫折后恢复了。',
    }))
    vi.stubGlobal('fetch', fetchMock)

    const session = await generateReadingSession({
      dayKey: '2026-07-13', batchIndex: 9, seed: 0, wordIds: ['w1'], level: 'B2',
    })

    expect(session.targetWordIds).toEqual(['w1'])
    expect(session.unquizzedTargetWordIds).toEqual([])
    expect(JSON.parse(session.targetsJson)[0].contextualMeaning).toBe('able to recover quickly')
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain('concise English definitions')
  })

  it('repairs duplicate distractors and never exposes an internal uuid', async () => {
    await db.localSecrets.put({ key: 'deepseekApiKey', value: 'test-key' })
    await db.settings.bulkPut([{ key: 'deepseekBaseUrl', value: 'https://example.test/chat' }, { key: 'deepseekModel', value: 'test-model' }])
    await db.dictionaryEntries.put({ entryId: 'core:marker', headword: 'marker', headwordLower: 'marker', posList: ['n'], sensesJson: '["标记物"]', examplesJson: '[]', usageJson: '[]' })
    await db.wordbook.put({ wordId: 'stable-marker-id', entryId: 'core:marker', headword: 'marker', headwordLower: 'marker', addedAt: '2026-07-13T00:00:00.000Z', note: '', tags: [], archived: 0 })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(articleStream({
        title: 'Markers',
        paragraphs: ['A marker showed the path.'],
        targets: [{ wordId: 'stable-marker-id', headword: 'marker', contextualMeaning: '标记物', choices: ['标记物', '标记物', '安静地点'], explanation: '用于指示位置。' }],
        translation: '一个标记物指出了道路。',
      }))
      .mockResolvedValueOnce(jsonCompletion({
        targets: [{
          wordId: 'stable-marker-id',
          headword: 'marker',
          sourceSense: '标记物',
          contextualMeaning: '标记物',
          choices: ['标记物', '安静地点', '快速动作'],
          explanation: '它指出了道路。',
        }],
      }))
    vi.stubGlobal('fetch', fetchMock)
    const session = await generateReadingSession({ dayKey: '2026-07-13', batchIndex: 1, seed: 0, wordIds: ['stable-marker-id'], level: 'B2' })
    expect(session.status).toBe('ready')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(session.segmentsJson).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)
    expect(session.targetWordIds).toEqual(['stable-marker-id'])
    expect(session.unquizzedTargetWordIds).toEqual([])
  })

  it('keeps a valid streamed article but does not invent fallback distractors when details fail', async () => {
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
    expect(JSON.parse(session.targetsJson)).toEqual([])
    expect(session.omittedTargetWordIds).toEqual([])
    expect(session.unquizzedTargetWordIds).toEqual(['w1'])
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
    expect(session.unquizzedTargetWordIds).toEqual([])
    expect(JSON.parse(session.targetsJson)).toHaveLength(4)
    expect(JSON.parse(session.segmentsJson)).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'vivid', wordId: 'w3' }),
    ]))
  })

  it('repairs missing passage coverage without discarding the original article', async () => {
    await db.localSecrets.put({ key: 'deepseekApiKey', value: 'test-key' })
    await db.settings.bulkPut([{ key: 'deepseekBaseUrl', value: 'https://example.test/chat' }, { key: 'deepseekModel', value: 'test-model' }])
    await db.dictionaryEntries.bulkPut([
      { entryId: 'e1', headword: 'resilient', headwordLower: 'resilient', posList: ['adj'], sensesJson: '["有韧性的"]', examplesJson: '[]', usageJson: '[]' },
      { entryId: 'e2', headword: 'tranquil', headwordLower: 'tranquil', posList: ['adj'], sensesJson: '["宁静的"]', examplesJson: '[]', usageJson: '[]' },
    ])
    await db.wordbook.bulkPut([
      { wordId: 'w1', entryId: 'e1', addedAt: '2026-07-13T00:00:00.000Z', note: '', tags: [], archived: 0 },
      { wordId: 'w2', entryId: 'e2', addedAt: '2026-07-13T00:00:00.000Z', note: '', tags: [], archived: 0 },
    ])
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(articleStream({
        title: 'Recovery',
        paragraphs: ['The resilient guide crossed the ridge.'],
        targets: [{ wordId: 'w1', headword: 'resilient', contextualMeaning: '有韧性的', choices: ['有韧性的', '潮湿的', '透明的'], explanation: '向导坚持前行。' }],
        translation: '那位坚韧的向导翻过山脊。',
      }))
      .mockResolvedValueOnce(jsonCompletion({
        supplements: [{
          wordId: 'w2',
          headword: 'tranquil',
          sentence: 'Below the ridge, a tranquil lake reflected the evening sky.',
          translation: '山脊下，一片宁静的湖泊映照着晚霞。',
        }],
      }))
      .mockResolvedValueOnce(jsonCompletion({
        targets: [{
          wordId: 'w2',
          headword: 'tranquil',
          sourceSense: '宁静的',
          contextualMeaning: '宁静的',
          choices: ['宁静的', '拥挤的', '昂贵的'],
          explanation: '湖面在傍晚很平静。',
        }],
      }))
    vi.stubGlobal('fetch', fetchMock)

    const session = await generateReadingSession({
      dayKey: '2026-07-13', batchIndex: 7, seed: 0, wordIds: ['w1', 'w2'], level: 'B2',
    })

    expect(session.status).toBe('ready')
    expect(session.omittedTargetWordIds).toEqual([])
    expect(session.unquizzedTargetWordIds).toEqual([])
    expect(session.segmentsJson).toContain('tranquil')
    expect(session.translation).toContain('宁静的湖泊')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('accepts a compatible non-stream response even when streaming was requested', async () => {
    await db.localSecrets.put({ key: 'deepseekApiKey', value: 'test-key' })
    await db.settings.bulkPut([{ key: 'deepseekBaseUrl', value: 'https://example.test/chat' }, { key: 'deepseekModel', value: 'test-model' }])
    await db.dictionaryEntries.put({ entryId: 'e1', headword: 'resilient', headwordLower: 'resilient', posList: ['adj'], sensesJson: '["有韧性的"]', examplesJson: '[]', usageJson: '[]' })
    await db.wordbook.put({ wordId: 'w1', entryId: 'e1', addedAt: '2026-07-13T00:00:00.000Z', note: '', tags: [], archived: 0 })
    const content = [
      JSON.stringify({ type: 'meta', title: 'Fallback Transport' }),
      JSON.stringify({ type: 'paragraph', text: 'A resilient bridge survived the storm.' }),
      JSON.stringify({ type: 'target', wordId: 'w1', headword: 'resilient', sourceSense: '有韧性的', contextualMeaning: '有韧性的', choices: ['有韧性的', '昂贵的', '狭窄的'], explanation: '桥经受住了风暴。' }),
      JSON.stringify({ type: 'translation', text: '一座有韧性的桥经受住了风暴。' }),
    ].join('')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content } }],
    }), { headers: { 'Content-Type': 'application/json' } })))

    const session = await generateReadingSession({
      dayKey: '2026-07-13', batchIndex: 8, seed: 0, wordIds: ['w1'], level: 'B2',
    })

    expect(session.status).toBe('ready')
    expect(session.title).toBe('Fallback Transport')
    expect(session.targetWordIds).toEqual(['w1'])
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

  it('keeps v2 omissions in an idempotent recovery batch instead of inflating the next ten-word article', async () => {
    const now = '2026-07-13T08:00:00.000Z'
    const first = Array.from({ length: 10 }, (_, index) => `a${index}`)
    const second = Array.from({ length: 10 }, (_, index) => `b${index}`)
    await db.dailyLearningSessions.put({
      sessionId: 'daily:2026-07-13', dayKey: '2026-07-13', status: 'active', phase: 'article',
      engineVersion: 2, readingBatchPlanVersion: 2,
      selectedListIds: [], initialWordIds: [...first, ...second], articleStatus: 'ready',
      readingBatchesJson: JSON.stringify([first, second]), activeReadingBatchIndex: 0,
      createdAt: now, updatedAt: now,
    })

    await appendOmittedReadingTargets('daily:2026-07-13', 0, ['a2'])
    await appendOmittedReadingTargets('daily:2026-07-13', 0, ['a2'])

    expect(await getOrCreateReadingBatches('daily:2026-07-13', '2026-07-13'))
      .toEqual([first, ['a2'], second])
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

  it('upgrades five-word v2 article batches into stable ten-word reading batches', async () => {
    const now = '2026-07-13T08:00:00.000Z'
    const wordIds = Array.from({ length: 20 }, (_, index) => `w${index + 1}`)
    const units = Array.from({ length: 4 }, (_, index) => ({
      unitId: `u${index + 1}`,
      index,
      wordIds: wordIds.slice(index * 5, index * 5 + 5),
      dueWordIds: [],
      newWordIds: wordIds.slice(index * 5, index * 5 + 5),
      status: index === 0 ? 'completed' : index === 1 ? 'active' : 'pending',
    }))
    await db.dailyLearningSessions.put({
      sessionId: 'daily:2026-07-13', dayKey: '2026-07-13', status: 'active', phase: 'article',
      engineVersion: 2, activeUnitIndex: 1, activeReadingBatchIndex: 1,
      selectedListIds: [], initialWordIds: wordIds, articleStatus: 'waiting',
      unitsJson: JSON.stringify(units),
      readingBatchesJson: JSON.stringify(units.map((unit) => unit.wordIds)),
      readingBatchRounds: 1,
      createdAt: now, updatedAt: now,
    })

    const batches = await getOrCreateReadingBatches('daily:2026-07-13', '2026-07-13')
    expect(batches.map((batch) => batch.length)).toEqual([10, 10])
    expect(batches.flat()).toEqual(wordIds)
    expect(await db.dailyLearningSessions.get('daily:2026-07-13')).toMatchObject({
      readingBatchPlanVersion: 2,
      activeReadingBatchIndex: 0,
    })
  })

  it('refreshes a v2 plan when new unit words keep the same batch count', async () => {
    const now = '2026-07-13T08:00:00.000Z'
    const original = Array.from({ length: 15 }, (_, index) => `w${index + 1}`)
    const added = Array.from({ length: 5 }, (_, index) => `w${index + 16}`)
    const allWords = [...original, ...added]
    const units = [
      { unitId: 'u1', index: 0, wordIds: original.slice(0, 10), dueWordIds: original.slice(0, 10), newWordIds: [], status: 'completed' },
      { unitId: 'u2', index: 1, wordIds: original.slice(10), dueWordIds: [], newWordIds: original.slice(10), status: 'active' },
      { unitId: 'u3', index: 2, wordIds: added, dueWordIds: [], newWordIds: added, status: 'pending' },
    ]
    await db.dailyLearningSessions.put({
      sessionId: 'daily:2026-07-13', dayKey: '2026-07-13', status: 'active', phase: 'article',
      engineVersion: 2, activeUnitIndex: 1, activeReadingBatchIndex: 1,
      selectedListIds: [], initialWordIds: allWords, articleStatus: 'waiting',
      unitsJson: JSON.stringify(units),
      readingBatchesJson: JSON.stringify([original.slice(0, 10), ['w2'], original.slice(10)]),
      readingBatchRounds: 1, readingBatchPlanVersion: 2,
      createdAt: now, updatedAt: now,
    })

    const batches = await getOrCreateReadingBatches('daily:2026-07-13', '2026-07-13')
    expect(batches).toEqual([allWords.slice(0, 10), ['w2'], allWords.slice(10)])
    expect((await db.dailyLearningSessions.get('daily:2026-07-13'))?.activeReadingBatchIndex).toBe(1)
  })

  it('rejects an old five-word article cache after its batch grows to ten words', () => {
    const now = '2026-07-13T08:00:00.000Z'
    const oldWords = Array.from({ length: 5 }, (_, index) => `w${index + 1}`)
    const cached = {
      sessionId: 'reading:2026-07-13:0:0',
      dayKey: '2026-07-13',
      batchIndex: 0,
      selectionSeed: 0,
      level: 'B2' as const,
      topic: '',
      targetWordIds: oldWords,
      sourceWordIds: oldWords,
      status: 'completed' as const,
      title: 'Old article',
      segmentsJson: JSON.stringify(oldWords.map((wordId) => ({ text: wordId, wordId }))),
      targetsJson: '[]',
      translation: '',
      createdAt: now,
      updatedAt: now,
    }

    expect(readingSessionMatchesBatch(cached, [...oldWords, 'w6', 'w7', 'w8', 'w9', 'w10']))
      .toBe(false)
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

  it('recognizes an inflected first word inside a multiword target', () => {
    const targets: ReadingTarget[] = [
      { wordId: 'account', headword: 'account for', contextualMeaning: 'explain', choices: ['explain', 'hide', 'remove'], explanation: '' },
      { wordId: 'run-out', headword: 'run out of', contextualMeaning: 'use completely', choices: ['use completely', 'restore', 'collect'], explanation: '' },
    ]
    const passage = 'They accounted for every expense before they ran out of cash.'

    expect(sortTargetsByPassageOrder(targets, passage, {
      accounted: 'account',
      ran: 'run',
    }).map((target) => target.wordId)).toEqual(['account', 'run-out'])
  })

  it('does not let an inflected phrase and its inner word share one surface match', () => {
    const targets: ReadingTarget[] = [
      { wordId: 'inner', headword: 'off', contextualMeaning: 'not operating', choices: ['not operating', 'active', 'nearby'], explanation: '' },
      { wordId: 'later', headword: 'rest', contextualMeaning: 'relax', choices: ['relax', 'work', 'rush'], explanation: '' },
      { wordId: 'phrase', headword: 'take off', contextualMeaning: 'leave the ground', choices: ['leave the ground', 'land', 'wait'], explanation: '' },
    ]
    const passage = 'They took off and then rested.'

    expect(sortTargetsByPassageOrder(targets, passage, {
      took: 'take',
      rested: 'rest',
    }).map((target) => target.wordId)).toEqual(['phrase', 'later', 'inner'])
  })

  it('falls back to a local reading pack when article generation has no API key', async () => {
    const now = '2026-07-13T00:00:00.000Z'
    await db.dictionaryEntries.put({ entryId: 'e1', headword: 'resilient', headwordLower: 'resilient', posList: ['adj'], sensesJson: '["有韧性的"]', examplesJson: '[]', usageJson: '[]' })
    await db.wordbook.put({ wordId: 'w1', entryId: 'e1', addedAt: now, note: '', tags: [], archived: 0 })
    const session = await generateReadingSession({ dayKey: '2026-07-13', batchIndex: 0, seed: 0, wordIds: ['w1'], level: 'B2' })

    expect(session.status).toBe('ready')
    expect(session.errorCode).toBe('missing-key')
    expect(session.title).toBe('离线词汇预习')
    expect(JSON.parse(session.targetsJson)).toEqual([])
  })

  it('does not retry a permanent article authorization failure', async () => {
    const now = '2026-07-13T00:00:00.000Z'
    await db.localSecrets.put({ key: 'deepseekApiKey', value: 'invalid-key' })
    await db.settings.bulkPut([
      { key: 'deepseekBaseUrl', value: 'https://example.test/chat' },
      { key: 'deepseekModel', value: 'test-model' },
    ])
    await db.dictionaryEntries.put({
      entryId: 'e1', headword: 'resilient', headwordLower: 'resilient', posList: ['adj'],
      sensesJson: '["有韧性的"]', examplesJson: '[]', usageJson: '[]',
    })
    await db.wordbook.put({
      wordId: 'w1', entryId: 'e1', addedAt: now, note: '', tags: [], archived: 0,
    })
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    const session = await generateReadingSession({
      dayKey: '2026-07-13', batchIndex: 8, seed: 0, wordIds: ['w1'], level: 'B2',
    })

    expect(session.status).toBe('ready')
    expect(session.errorCode).toBe('unauthorized')
    expect(fetchMock).toHaveBeenCalledTimes(1)
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
