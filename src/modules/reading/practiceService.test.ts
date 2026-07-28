import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../db/database'
import type { PracticeQuestion } from '../../types/models'
import {
  generateRoundPractice,
  recordPracticeAnswer,
  scheduleRoundPractice,
  scorePracticeCandidate,
} from './practiceService'
import { resumeDailyCardsAfterPractice } from '../review/dailyQueueService'

async function seedRound(questionLimit: number) {
  const now = '2026-07-13T08:00:00.000Z'
  await db.settings.bulkPut([
    { key: 'practiceQuestionLimit', value: questionLimit },
    { key: 'deepseekBaseUrl', value: 'https://example.test/chat' },
    { key: 'deepseekModel', value: 'test-model' },
  ])
  await db.localSecrets.put({ key: 'deepseekApiKey', value: 'test-key' })
  for (const [index, headword] of ['resilient', 'vivid'].entries()) {
    const wordId = `w${index + 1}`
    await db.dictionaryEntries.put({
      entryId: `e${index + 1}`,
      headword,
      headwordLower: headword,
      posList: ['adj'],
      sensesJson: JSON.stringify(index ? ['生动的', '鲜明的'] : ['有韧性的', '能恢复的']),
      examplesJson: '[]',
      usageJson: '[]',
    })
    await db.wordbook.put({ wordId, entryId: `e${index + 1}`, addedAt: now, note: '', tags: [], archived: 0 })
    await db.dailyQueueItems.put({
      itemId: `daily:2026-07-13:${wordId}:1`, sessionId: 'daily:2026-07-13', kind: 'card', wordId,
      reason: 'initial', roundIndex: 1, position: index, status: 'pending', attemptNo: 1, maxAttempts: 5,
      retrievability: 0.5, startingLongTermRetrievability: 0.5, wasNew: true, createdAt: now, updatedAt: now,
    })
    await db.contextAttempts.put({
      attemptId: `old:${wordId}`, sessionId: 'old', wordId, result: 'wrong', answeredAt: now,
    })
  }
  await db.dailyLearningSessions.put({
    sessionId: 'daily:2026-07-13', dayKey: '2026-07-13', status: 'active', phase: 'cards',
    selectedListIds: [], initialWordIds: ['w1', 'w2'], activeRoundIndex: 1,
    roundsJson: JSON.stringify([{ index: 1, wordIds: ['w1', 'w2'], status: 'active', startedAt: now }]),
    articleStatus: 'waiting', createdAt: now, updatedAt: now,
  })
}

function validPracticeResponse(request: RequestInit): Response {
  const body = JSON.parse(String(request.body)) as { messages: Array<{ content: string }> }
  const match = body.messages[0]!.content.match(/SPECS: (.+)\nReturn one JSON object/)
  const specs = JSON.parse(match?.[1] ?? '[]') as Array<{
    questionId: string
    type: PracticeQuestion['type']
    focusWordId: string
    headword: string
    sourceSense: string
    correctAnswer: string
  }>
  const questions: PracticeQuestion[] = specs.map((spec) => ({
    questionId: spec.questionId,
    type: spec.type,
    focusWordId: spec.focusWordId,
    headword: spec.headword,
    sourceSense: spec.sourceSense,
    passage: spec.type === 'meaning-in-context'
      ? `Although the first trial failed, the ${spec.headword} team revised its plan, recovered quickly, and completed the difficult project without losing confidence or focus.`
      : undefined,
    stem: spec.type === 'meaning-in-context' ? 'What does the target word mean here?' : `Which sentence uses ${spec.headword} correctly?`,
    options: spec.type === 'meaning-in-context'
      ? [spec.correctAnswer, '不愿意作决定', '容易被完全忽略', '可能保持安静']
      : [spec.correctAnswer, `She ${spec.headword} the box under a desk.`, `They arrived ${spec.headword} before noon.`, `The rain was ${spec.headword} into glass.`],
    correctIndex: 0,
    evidence: ['the first trial failed', 'recovered quickly'],
    explanation: '上下文给出了恢复与完成任务两条线索。',
    distractorExplanations: ['符合语境。', '词性或搭配不正确。', '语义不符合。', '搭配不成立。'],
  }))
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ questions }) } }] }))
}

describe('round practice planning and generation', () => {
  beforeEach(async () => {
    db.close()
    await db.delete()
    await db.open()
    vi.unstubAllGlobals()
  })

  it('scores only local learning evidence and applies the documented penalties', () => {
    expect(scorePracticeCandidate({
      wasNew: true, retrievability: 0.5, rating: 'again', senseCount: 2,
      recentContextFailure: true, neverContextTested: false, correctContextToday: false, testedInRecentRounds: false,
    })).toBe(100)
    expect(scorePracticeCandidate({
      wasNew: false, retrievability: 0.9, rating: 'good', senseCount: 1,
      recentContextFailure: false, neverContextTested: false, correctContextToday: true, testedInRecentRounds: true,
    })).toBe(0)
  })

  it('honors the configurable daily cap and sends one grouped thinking request', async () => {
    await seedRound(1)
    const fetchMock = vi.fn((_url: string, request: RequestInit) => Promise.resolve(validPracticeResponse(request)))
    vi.stubGlobal('fetch', fetchMock)

    const planned = await scheduleRoundPractice('daily:2026-07-13', 1)
    expect(planned?.plannedQuestionCount).toBe(1)
    const ready = await generateRoundPractice(planned!.sessionId)

    expect(ready.status).toBe('ready')
    expect(JSON.parse(ready.questionsJson ?? '[]')).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(request).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high' })
    expect(request.temperature).toBeUndefined()
  })

  it('uses a local self-recall exercise when no AI key is configured', async () => {
    await seedRound(1)
    await db.localSecrets.delete('deepseekApiKey')

    const planned = await scheduleRoundPractice('daily:2026-07-13', 1)
    const ready = await generateRoundPractice(planned!.sessionId)
    const [question] = JSON.parse(ready.questionsJson ?? '[]') as PracticeQuestion[]

    expect(ready.status).toBe('ready')
    expect(ready.errorCode).toBe('missing-key')
    expect(question).toMatchObject({
      type: 'self-recall',
      sourceSense: '有韧性的',
      options: ['想起来了', '还没想起来'],
      correctIndex: 0,
      hintLevel: 2,
    })
  })

  it('keeps context evidence outside FSRS and schedules a later card after an error', async () => {
    await seedRound(2)
    const fetchMock = vi.fn((_url: string, request: RequestInit) => Promise.resolve(validPracticeResponse(request)))
    vi.stubGlobal('fetch', fetchMock)
    const planned = await scheduleRoundPractice('daily:2026-07-13', 1)
    const ready = await generateRoundPractice(planned!.sessionId)
    const [question] = JSON.parse(ready.questionsJson ?? '[]') as PracticeQuestion[]

    const attempt = await recordPracticeAnswer(ready.sessionId, question!, 1, 'daily:2026-07-13', 1)

    expect(await db.reviewLogs.count()).toBe(0)
    expect(await db.reviewState.count()).toBe(0)
    expect(await db.dailyQueueItems.filter((item) => item.reason === 'context-retry').count()).toBe(1)
    expect(attempt.hintLevel).toBe(2)
  })

  it('defers an impossible terminal context retry instead of deadlocking the session', async () => {
    await seedRound(2)
    await db.localSecrets.delete('deepseekApiKey')
    const planned = await scheduleRoundPractice('daily:2026-07-13', 1)
    const ready = await generateRoundPractice(planned!.sessionId)
    const [question] = JSON.parse(ready.questionsJson ?? '[]') as PracticeQuestion[]
    const unitId = 'daily:2026-07-13:unit:1'
    await db.dailyQueueItems.where('sessionId').equals('daily:2026-07-13').modify({
      status: 'completed',
      unitId,
      stage: 'learn',
    })
    await db.dailyLearningSessions.update('daily:2026-07-13', {
      engineVersion: 2,
      phase: 'practice',
      learningStage: 'transfer',
      activeUnitIndex: 0,
      activityOrdinal: 0,
      sessionRevision: 1,
      unitsJson: JSON.stringify([{
        unitId,
        index: 0,
        wordIds: ['w1', 'w2'],
        dueWordIds: [],
        newWordIds: ['w1', 'w2'],
        status: 'active',
      }]),
      pendingPracticeRoundIndex: 1,
      pendingPracticeSessionId: ready.sessionId,
    })

    const attempt = await recordPracticeAnswer(ready.sessionId, question!, 1, 'daily:2026-07-13', 1)
    const snapshot = await resumeDailyCardsAfterPractice(
      'daily:2026-07-13',
      new Date(attempt.answeredAt),
    )

    expect(snapshot.session).toMatchObject({ status: 'completed', phase: 'summary' })
    expect(snapshot.items.find((item) => item.reason === 'context-retry')).toMatchObject({
      status: 'skipped',
      memoryStatus: 'tomorrow',
      tomorrowPriority: true,
    })
    expect(snapshot.nextAvailableAt).toBeUndefined()
  })
})
