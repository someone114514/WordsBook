import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../db/database'
import type { ReadingTarget, ReviewLog } from '../../types/models'
import { buildReadingTargetBatches, generateReadingSession, recordContextAttempt } from './readingService'

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

  it('balances large mandatory sets into batches of no more than 25', async () => {
    await db.reviewLogs.bulkAdd(Array.from({ length: 60 }, (_, index) => log(`new-${index}`, 'good', true)))
    const batches = await buildReadingTargetBatches('2026-07-13', 0)
    expect(batches).toHaveLength(3)
    expect(batches.every((batch) => batch.length === 20)).toBe(true)
  })

  it('retries an invalid AI payload once and caches the validated article', async () => {
    await db.localSecrets.put({ key: 'deepseekApiKey', value: 'test-key' })
    await db.settings.bulkPut([
      { key: 'deepseekBaseUrl', value: 'https://example.test/chat' },
      { key: 'deepseekModel', value: 'test-model' },
    ])
    await db.dictionaryEntries.put({ entryId: 'e1', headword: 'resilient', headwordLower: 'resilient', posList: ['adj'], sensesJson: '["有韧性的"]', examplesJson: '[]', usageJson: '[]' })
    await db.wordbook.put({ wordId: 'w1', entryId: 'e1', addedAt: '2026-07-13T00:00:00.000Z', note: '', tags: [], archived: 0 })
    const streamResponse = (lines: unknown[]) => new Response(lines.map((line) => `data: ${JSON.stringify({ choices: [{ delta: { content: `${JSON.stringify(line)}\n` } }] })}\n\n`).join(''))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse([{ type: 'meta', title: 'Incomplete' }]))
      .mockResolvedValueOnce(streamResponse([
        { type: 'meta', title: 'A Test', level: 'B2', targetWordIds: ['w1'] },
        { type: 'paragraph', text: 'She stayed resilient.' },
        { type: 'target', wordId: 'w1', headword: 'resilient', contextualMeaning: '有韧性的', choices: ['有韧性的', '迟缓的', '安静的'], explanation: '面对困难仍能恢复。' },
        { type: 'translation', text: '她保持坚韧。' },
        { type: 'done' },
      ]))
    vi.stubGlobal('fetch', fetchMock)
    const staleWordId = 'd7d467fe-fd5e-48e7-81c8-e64b242c8a9b'
    const session = await generateReadingSession({ dayKey: '2026-07-13', batchIndex: 0, seed: 9, wordIds: ['w1', staleWordId], level: 'B2' })
    expect(session.status).toBe('ready')
    expect(session.targetWordIds).toEqual(['w1'])
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).not.toContain(staleWordId)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((await db.readingSessions.get(session.sessionId))?.title).toBe('A Test')
  })

  it('rejects near-synonym distractors and never exposes an internal uuid', async () => {
    await db.localSecrets.put({ key: 'deepseekApiKey', value: 'test-key' })
    await db.settings.bulkPut([{ key: 'deepseekBaseUrl', value: 'https://example.test/chat' }, { key: 'deepseekModel', value: 'test-model' }])
    await db.dictionaryEntries.put({ entryId: 'core:marker', headword: 'marker', headwordLower: 'marker', posList: ['n'], sensesJson: '["标记物"]', examplesJson: '[]', usageJson: '[]' })
    await db.wordbook.put({ wordId: 'stable-marker-id', entryId: 'core:marker', headword: 'marker', headwordLower: 'marker', addedAt: '2026-07-13T00:00:00.000Z', note: '', tags: [], archived: 0 })
    const stream = (choices: string[]) => new Response([
      { type: 'meta', title: 'Markers', level: 'B2', targetWordIds: ['stable-marker-id'] },
      { type: 'paragraph', text: 'A marker showed the path.' },
      { type: 'target', wordId: 'stable-marker-id', headword: 'marker', contextualMeaning: '标记物', choices, explanation: '用于指示位置。' },
      { type: 'translation', text: '一个标记物指出了道路。' },
      { type: 'done' },
    ].map((line) => `data: ${JSON.stringify({ choices: [{ delta: { content: `${JSON.stringify(line)}\n` } }] })}\n\n`).join(''))
    const repairResponse = new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ targets: [{ wordId: 'stable-marker-id', choices: ['标记物', '饮用容器', '交通工具'], explanation: '用于指示位置。' }] }) } }] }), { headers: { 'Content-Type': 'application/json' } })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(stream(['标记物', '标记的物体', '安静地点']))
      .mockResolvedValueOnce(repairResponse)
    vi.stubGlobal('fetch', fetchMock)
    const session = await generateReadingSession({ dayKey: '2026-07-13', batchIndex: 1, seed: 0, wordIds: ['stable-marker-id'], level: 'B2' })
    expect(session.status).toBe('ready')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(session.segmentsJson).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)
  })
})
