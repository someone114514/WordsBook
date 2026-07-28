import dayjs from 'dayjs'
import { db } from '../../db/database'
import type {
  ContextAttempt,
  DailyLearningSession,
  PracticeQuestion,
  PracticeQuestionType,
  ReadingSession,
  ReviewRating,
} from '../../types/models'
import { createDeepseekRequest } from '../ai/deepseekRequest'
import {
  GenerationRequestError,
  requestJsonCompletion,
  runSerializedGeneration,
} from '../ai/generationClient'
import { loadSettings } from '../settings/settingsService'
import { markPayloadChanged } from '../sync/localSyncStore'
import { recordContextLearningEvidence } from '../review/dailyQueueService'
import { parseJsonArray } from '../../utils/json'
import { parseSenseRecords } from '../dictionary/senseRecords'

const PRACTICE_PROMPT_VERSION = 'v1-guided-context'
const activePracticeGenerations = new Map<string, Promise<ReadingSession>>()

interface PracticeSpec {
  questionId: string
  type: PracticeQuestionType
  focusWordId: string
  headword: string
  allowedSenses: string[]
  sourceSense: string
  correctAnswer: string
  trustedExample?: string
  difficulty: 'guided' | 'standard'
  hintLevel: 0 | 1 | 2
  distractorCloseness: 'broad' | 'near'
}

interface CandidateInput {
  wasNew: boolean
  retrievability: number
  rating?: ReviewRating
  repeatedWithoutPass?: boolean
  senseCount: number
  recentContextFailure: boolean
  neverContextTested: boolean
  correctContextToday: boolean
  testedInRecentRounds: boolean
}

export function scorePracticeCandidate(input: CandidateInput): number {
  let score = 0
  if (input.rating === 'again') score += 40
  else if (input.rating === 'hard') score += 25
  else if (input.repeatedWithoutPass) score += 12
  if (input.wasNew) score += 25
  if (input.retrievability < 0.6) score += 20
  else if (input.retrievability < 0.8) score += 10
  if (input.recentContextFailure) score += 15
  if (input.senseCount > 1) score += 15
  if (input.neverContextTested) score += 8
  if (input.correctContextToday) score -= 40
  if (input.testedInRecentRounds) score -= 20
  return Math.max(0, Math.min(100, score))
}

function stableHash(values: string[]): string {
  let value = 2166136261
  for (const char of [...values].sort().join('|')) {
    value ^= char.charCodeAt(0)
    value = Math.imul(value, 16777619)
  }
  return (value >>> 0).toString(36)
}

function parseQuestions(session: ReadingSession): PracticeQuestion[] {
  try {
    const parsed = JSON.parse(session.questionsJson ?? '[]') as unknown
    return Array.isArray(parsed) ? parsed as PracticeQuestion[] : []
  } catch { return [] }
}

function normalizeAnswer(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function containsWholeHeadword(value: string, headword: string): boolean {
  const escaped = headword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  return new RegExp(`(^|[^A-Za-z])${escaped}([^A-Za-z]|$)`, 'i').test(value)
}

function validateQuestions(value: unknown, specs: PracticeSpec[]): PracticeQuestion[] {
  if (!value || typeof value !== 'object') throw new Error('语意练习结构不完整')
  const rows = (value as { questions?: unknown }).questions
  if (!Array.isArray(rows) || rows.length !== specs.length) throw new Error('语意练习数量不完整')
  const specById = new Map(specs.map((spec) => [spec.questionId, spec]))
  const questions = rows as PracticeQuestion[]
  for (const question of questions) {
    const spec = specById.get(question.questionId)
    if (!spec || question.focusWordId !== spec.focusWordId || question.type !== spec.type) throw new Error('语意练习目标不匹配')
    if (question.headword.toLowerCase() !== spec.headword.toLowerCase()) throw new Error('语意练习词形不匹配')
    if (
      !question.sourceSense
      || normalizeAnswer(question.sourceSense) !== normalizeAnswer(spec.sourceSense)
      || !spec.allowedSenses.some((sense) => normalizeAnswer(sense) === normalizeAnswer(question.sourceSense))
    ) throw new Error('语意练习使用了未授权词义')
    if (
      !Array.isArray(question.options)
      || question.options.length !== 4
      || new Set(question.options.map(normalizeAnswer)).size !== 4
    ) throw new Error('语意练习选项无效')
    if (!Number.isInteger(question.correctIndex) || question.correctIndex < 0 || question.correctIndex > 3) throw new Error('语意练习答案无效')
    if (normalizeAnswer(question.options[question.correctIndex] ?? '') !== normalizeAnswer(spec.correctAnswer)) {
      throw new Error('语意练习正确答案未绑定到词典证据')
    }
    if (!Array.isArray(question.evidence) || question.evidence.length < 2 || !question.explanation) throw new Error('语意练习解析不完整')
    if (!Array.isArray(question.distractorExplanations) || question.distractorExplanations.length !== 4) throw new Error('语意练习选项解析不完整')
    if (question.type === 'meaning-in-context' && (
      !question.passage
      || question.passage.split(/\s+/).length < 20
      || !containsWholeHeadword(question.passage, spec.headword)
    )) throw new Error('语意练习短文过短或未覆盖目标词')
    if (question.type === 'usage-discrimination'
      && !question.options.every((option) => containsWholeHeadword(option, spec.headword))) {
      throw new Error('用法辨析没有在每个选项中保留目标词')
    }
  }
  return questions.map((question) => ({
    ...question,
    // Hint strength is a scheduler decision. Never let generated content alter it.
    hintLevel: specById.get(question.questionId)!.hintLevel,
  }))
}

function shuffleQuestionOptions(question: PracticeQuestion, seed: string): PracticeQuestion {
  const rows = question.options.map((option, index) => ({
    option,
    explanation: question.distractorExplanations[index] ?? '',
    wasCorrect: index === question.correctIndex,
  })).sort((left, right) =>
    stableHash([`${seed}:${left.option}`]).localeCompare(stableHash([`${seed}:${right.option}`])))
  return {
    ...question,
    options: rows.map((row) => row.option),
    distractorExplanations: rows.map((row) => row.explanation),
    correctIndex: rows.findIndex((row) => row.wasCorrect),
  }
}

function buildLocalRecallQuestions(specs: PracticeSpec[]): PracticeQuestion[] {
  return specs.map((spec) => {
    const passage = spec.trustedExample
      ? spec.trustedExample.replace(
          new RegExp(spec.headword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
          '____',
        )
      : undefined
    return {
      questionId: `${spec.questionId}:local`,
      type: 'self-recall',
      focusWordId: spec.focusWordId,
      headword: spec.headword,
      hintLevel: spec.hintLevel,
      sourceSense: spec.sourceSense,
      passage,
      stem: passage
        ? '先补全句中的单词，再回想它在这里的含义。'
        : '遮住答案，先主动回想这个词的核心含义。',
      options: ['想起来了', '还没想起来'],
      correctIndex: 0,
      evidence: [
        `核心词义：${spec.sourceSense}`,
        ...(spec.trustedExample ? [`词典例句：${spec.trustedExample}`] : []),
      ],
      explanation: `核心词义：${spec.sourceSense}`,
      distractorExplanations: [
        '已完成一次无提示主动提取。',
        '先查看词义与例句；系统会把它加入稍后的延迟复习。',
      ],
    }
  })
}

function buildPracticePrompt(specs: PracticeSpec[]): string {
  return `Create exactly ${specs.length} English vocabulary practice question(s). The local app has already selected every target and question type; do not change them.
SPECS: ${JSON.stringify(specs)}
Return one JSON object only: {"questions":[{"questionId":"exact id","type":"meaning-in-context|usage-discrimination","focusWordId":"exact id","headword":"exact headword","sourceSense":"copy the exact sourceSense from the spec","passage":"required only for meaning-in-context","stem":"clear English instruction","options":["exactly four options"],"correctIndex":0,"evidence":["at least two clear context clues"],"explanation":"concise Simplified Chinese explanation","distractorExplanations":["one concise Simplified Chinese explanation for each option"]}]}.
For meaning-in-context, write a 35-80 word passage that contains the headword naturally and asks for its precise meaning. Copy correctAnswer verbatim as one option and point correctIndex to it; use the same language for all distractors.
For usage-discrimination, use correctAnswer verbatim as the one correct sentence. Make the other three options complete English sentences containing the same headword and point correctIndex to the trusted sentence.
Use only an allowed sense. Guided difficulty must use common syntax and obvious but nontrivial clues at no higher than CEFR B2. Standard difficulty may be harder but must not require specialist facts.
Every question needs at least two independent clues. Do not use obscure senses, double negatives, grammar traps, near-synonym hair-splitting, or misleading ambiguity. Distractors should be plausible at first glance but clearly wrong for an explainable semantic or collocational reason.`
}

async function candidateRows(
  dailySession: DailyLearningSession,
  wordIds: string[],
  roundIndex: number,
  provisional?: { wordId: string; rating: ReviewRating },
  requireCurrentRound = true,
) {
  const [items, attempts, words, contextAttempts, recentBundles] = await Promise.all([
    db.dailyQueueItems.where('sessionId').equals(dailySession.sessionId).toArray(),
    db.dailyQueueAttempts.where('sessionId').equals(dailySession.sessionId).toArray(),
    db.wordbook.bulkGet(wordIds),
    wordIds.length ? db.contextAttempts.where('wordId').anyOf(wordIds).toArray() : Promise.resolve([]),
    db.readingSessions.where('dayKey').equals(dailySession.dayKey).toArray(),
  ])
  const entries = await db.dictionaryEntries.bulkGet(words.map((word) => word?.entryId ?? ''))
  const contextByWord = new Map(wordIds.map((wordId) => [wordId, contextAttempts.filter((attempt) => attempt.wordId === wordId)]))
  const testedRecently = new Set(recentBundles
    .filter((bundle) => bundle.contentKind === 'round-practice' && bundle.batchIndex >= roundIndex - 2)
    .flatMap((bundle) => parseQuestions(bundle).map((question) => question.focusWordId)))
  return wordIds.flatMap((wordId, index) => {
    const word = words[index]
    const entry = entries[index]
    const item = items.find((row) => row.wordId === wordId
      && (!requireCurrentRound || (row.roundIndex ?? roundIndex) === roundIndex))
    const headword = entry?.headword ?? word?.headword
    const senseRecords = entry ? parseSenseRecords(entry) : []
    const senses = senseRecords.length
      ? senseRecords
          .map((sense) => sense.definitionEn ?? sense.glossZh ?? '')
          .filter(Boolean)
          .slice(0, 4)
      : []
    const examples = entry
      ? [...new Set([
          ...senseRecords.flatMap((sense) => sense.examples),
          ...parseJsonArray(entry.examplesJson),
        ])].filter((example) => containsWholeHeadword(example, headword ?? '')).slice(0, 4)
      : []
    if (!item || !headword || !/^[A-Za-z][A-Za-z' -]{1,79}$/.test(headword) || !senses.length) return []
    const wordAttempts = attempts.filter((attempt) => attempt.wordId === wordId)
    const latestRating = provisional?.wordId === wordId
      ? provisional.rating
      : wordAttempts[wordAttempts.length - 1]?.rating
    const contexts = contextByWord.get(wordId) ?? []
    const todayStart = dayjs(dailySession.dayKey).startOf('day')
    const recentStart = todayStart.subtract(7, 'day')
    const score = scorePracticeCandidate({
      wasNew: Boolean(item.wasNew),
      retrievability: item.startingLongTermRetrievability ?? item.retrievability,
      rating: latestRating,
      repeatedWithoutPass: wordAttempts.length > 0 && !wordAttempts.some((attempt) => attempt.masteryAfter === 100),
      senseCount: senses.length,
      recentContextFailure: contexts.some((attempt) => !dayjs(attempt.answeredAt).isBefore(recentStart) && attempt.result !== 'correct'),
      neverContextTested: contexts.length === 0,
      correctContextToday: contexts.some((attempt) => !dayjs(attempt.answeredAt).isBefore(todayStart) && attempt.result === 'correct'),
      testedInRecentRounds: testedRecently.has(wordId),
    })
    return [{ wordId, headword, senses, examples, score, latestRating, contexts }]
  }).sort((left, right) => right.score - left.score || left.wordId.localeCompare(right.wordId))
}

export async function scheduleRoundPractice(
  dailySessionId: string,
  roundIndex: number,
  provisional?: { wordId: string; rating: ReviewRating },
): Promise<ReadingSession | undefined> {
  const [dailySession, settings] = await Promise.all([
    db.dailyLearningSessions.get(dailySessionId),
    loadSettings(),
  ])
  if (!dailySession
    || settings.practiceQuestionLimit <= 0
    || dailySession.lastPracticeRoundIndex === roundIndex) return undefined
  if (dailySession.pendingPracticeRoundIndex === roundIndex && dailySession.pendingPracticeSessionId) {
    const existing = await db.readingSessions.get(dailySession.pendingPracticeSessionId)
    if (existing) return existing
  }
  const round = (() => {
    try { return (JSON.parse(dailySession.roundsJson ?? '[]') as Array<{ index: number; wordIds: string[] }>).find((row) => row.index === roundIndex) }
    catch { return undefined }
  })()
  if (!round?.wordIds.length) return undefined
  const allItems = await db.dailyQueueItems.where('sessionId').equals(dailySessionId).toArray()
  const allWordIds = [...new Set(allItems.filter((item) => item.kind === 'card' && item.wordId).map((item) => item.wordId!))]
  const [currentCandidates, globalCandidates, bundles] = await Promise.all([
    candidateRows(dailySession, round.wordIds, roundIndex, provisional),
    candidateRows(dailySession, allWordIds, roundIndex, provisional, false),
    db.readingSessions.where('dayKey').equals(dailySession.dayKey).toArray(),
  ])
  const eligible = globalCandidates.filter((candidate) => candidate.score >= 30)
  const urgent = eligible.filter((candidate) => candidate.score >= 70)
  const algorithmBudget = eligible.length
    ? Math.ceil(eligible.length / 8) + Math.min(2, Math.floor(urgent.length / 2))
    : 0
  const dailyBudget = Math.min(settings.practiceQuestionLimit, algorithmBudget)
  const used = bundles.filter((bundle) => bundle.contentKind === 'round-practice' && !bundle.skippedAt)
    .reduce((sum, bundle) => sum + (bundle.plannedQuestionCount ?? parseQuestions(bundle).length), 0)
  const remaining = Math.max(0, dailyBudget - used)
  const top = currentCandidates.filter((candidate) => candidate.score >= 30)
  if (!remaining || !top.length) return undefined
  if (dailySession.lastPracticeRoundIndex === roundIndex - 1 && top[0]!.score < 70) return undefined
  const count = Math.min(remaining, top.length > 1 && top[1]!.score >= 70 ? 2 : 1)
  const selected = top.slice(0, count)
  const recentAttempts = [...new Map(globalCandidates
    .flatMap((candidate) => candidate.contexts)
    .sort((left, right) => right.answeredAt.localeCompare(left.answeredAt))
    .map((attempt) => [attempt.attemptId, attempt] as const)).values()].slice(0, 20)
  const rollingAccuracy = recentAttempts.length
    ? recentAttempts.filter((attempt) => attempt.result === 'correct').length / recentAttempts.length
    : 0.85
  let previousType: PracticeQuestionType | undefined
  const specs: PracticeSpec[] = selected.map((candidate, index) => {
    const hasMeaningRisk = candidate.senses.length > 1 || candidate.contexts.some((attempt) => attempt.result !== 'correct')
    let type: PracticeQuestionType = hasMeaningRisk || !candidate.examples.length
      ? 'meaning-in-context'
      : 'usage-discrimination'
    if (index === 1 && type === previousType) {
      type = type === 'meaning-in-context' && candidate.examples.length
        ? 'usage-discrimination'
        : 'meaning-in-context'
    }
    previousType = type
    const guided = rollingAccuracy < 0.75
      || candidate.latestRating === 'again'
      || candidate.latestRating === 'hard'
      || candidate.score >= 70
    return {
      questionId: `round-${roundIndex}-${candidate.wordId}`,
      type,
      focusWordId: candidate.wordId,
      headword: candidate.headword,
      allowedSenses: candidate.senses,
      sourceSense: candidate.senses[0]!,
      correctAnswer: type === 'usage-discrimination'
        ? candidate.examples[0]!
        : candidate.senses[0]!,
      trustedExample: candidate.examples[0],
      difficulty: guided ? 'guided' : 'standard',
      hintLevel: guided ? 2 : rollingAccuracy > 0.95 ? 0 : 1,
      distractorCloseness: rollingAccuracy > 0.95 ? 'near' : 'broad',
    }
  })
  const sourceHash = stableHash(round.wordIds)
  const sessionId = `practice:${dailySession.dayKey}:round:${roundIndex}:${sourceHash}`
  const existing = await db.readingSessions.get(sessionId)
  if (existing && ['pending', 'streaming', 'ready', 'completed', 'failed'].includes(existing.status)) return existing
  const now = new Date().toISOString()
  const record: ReadingSession = {
    sessionId,
    dayKey: dailySession.dayKey,
    batchIndex: roundIndex,
    selectionSeed: 0,
    level: settings.articleLevel,
    topic: '',
    contentKind: 'round-practice',
    sourceWordIds: round.wordIds,
    sourceWordSetHash: sourceHash,
    promptVersion: PRACTICE_PROMPT_VERSION,
    plannedQuestionCount: count,
    candidateWordIds: selected.map((candidate) => candidate.wordId),
    practiceSpecJson: JSON.stringify(specs),
    questionsJson: '[]',
    targetWordIds: selected.map((candidate) => candidate.wordId),
    status: 'pending',
    segmentsJson: '[]',
    targetsJson: '[]',
    translation: '',
    generationAttemptCount: existing?.generationAttemptCount ?? 0,
    successfulGenerationCount: existing?.successfulGenerationCount ?? 0,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  const updatedDaily = {
    ...dailySession,
    pendingPracticeRoundIndex: roundIndex,
    pendingPracticeSessionId: sessionId,
    sessionRevision: (dailySession.sessionRevision ?? 0) + 1,
    updatedAt: now,
  }
  await db.transaction('rw', [db.readingSessions, db.dailyLearningSessions], async () => {
    await db.readingSessions.put(record)
    await db.dailyLearningSessions.put(updatedDaily)
  })
  await markPayloadChanged('readingSessions', record, now)
  await markPayloadChanged('dailyLearningSessions', updatedDaily, now)
  void generateRoundPractice(sessionId)
  return record
}

async function generateRoundPracticeImpl(sessionId: string): Promise<ReadingSession> {
  const session = await db.readingSessions.get(sessionId)
  if (!session) throw new Error('语意练习任务不存在')
  if (session.status === 'ready' || session.status === 'completed') return session
  const settings = await loadSettings()
  const specs = JSON.parse(session.practiceSpecJson ?? '[]') as PracticeSpec[]
  if (!settings.deepseekApiKey.trim()) {
    const ready = {
      ...session,
      status: 'ready' as const,
      questionsJson: JSON.stringify(buildLocalRecallQuestions(specs)),
      error: '未配置 API Key，已切换为本地主动回忆',
      errorCode: 'missing-key' as const,
      updatedAt: new Date().toISOString(),
    }
    await db.readingSessions.put(ready)
    await markPayloadChanged('readingSessions', ready, ready.updatedAt)
    return ready
  }
  const generating = { ...session, status: 'streaming' as const, generationAttemptCount: (session.generationAttemptCount ?? 0) + 1, error: undefined, errorCode: undefined, updatedAt: new Date().toISOString() }
  await db.readingSessions.put(generating)
  await markPayloadChanged('readingSessions', generating, generating.updatedAt)
  let lastError: unknown
  const basePrompt = buildPracticePrompt(specs)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const repairNote = attempt === 1 && lastError
        ? `\nThe previous response failed validation: ${lastError instanceof Error ? lastError.message : String(lastError)}. Repair that exact contract error.`
        : ''
      const payload = await requestJsonCompletion({
        url: settings.deepseekBaseUrl,
        apiKey: settings.deepseekApiKey,
        body: createDeepseekRequest({
          model: settings.deepseekModel,
          messages: [{ role: 'user', content: `${basePrompt}${repairNote}` }],
          stream: false,
          responseFormat: true,
          maxTokens: 3600,
        }),
      })
      let questions: PracticeQuestion[]
      try {
        questions = validateQuestions(payload, specs)
          .map((question) => shuffleQuestionOptions(question, `${sessionId}:${question.questionId}`))
      } catch (error) {
        throw new GenerationRequestError(
          error instanceof Error ? error.message : '语意练习合同无效',
          'contract-invalid',
        )
      }
      const ready: ReadingSession = {
        ...generating,
        status: 'ready',
        questionsJson: JSON.stringify(questions),
        successfulGenerationCount: (generating.successfulGenerationCount ?? 0) + 1,
        error: undefined,
        errorCode: undefined,
        updatedAt: new Date().toISOString(),
      }
      await db.readingSessions.put(ready)
      await markPayloadChanged('readingSessions', ready, ready.updatedAt)
      return ready
    } catch (error) {
      lastError = error
      if (attempt === 0) await new Promise((resolve) => globalThis.setTimeout(resolve, 800))
    }
  }
  const localFallback: ReadingSession = {
    ...generating,
    status: 'ready',
    questionsJson: JSON.stringify(buildLocalRecallQuestions(specs)),
    error: `AI 练习不可用，已切换为本地主动回忆：${lastError instanceof Error ? lastError.message : String(lastError)}`,
    errorCode: lastError instanceof GenerationRequestError ? lastError.code : 'contract-invalid',
    updatedAt: new Date().toISOString(),
  }
  await db.readingSessions.put(localFallback)
  await markPayloadChanged('readingSessions', localFallback, localFallback.updatedAt)
  return localFallback
}

export function generateRoundPractice(sessionId: string): Promise<ReadingSession> {
  const active = activePracticeGenerations.get(sessionId)
  if (active) return active
  const run = () => generateRoundPracticeImpl(sessionId)
  const task = runSerializedGeneration(run)
    .finally(() => activePracticeGenerations.delete(sessionId))
  activePracticeGenerations.set(sessionId, task)
  return task
}

export async function retryRoundPractice(sessionId: string): Promise<ReadingSession> {
  const session = await db.readingSessions.get(sessionId)
  if (!session) throw new Error('语意练习任务不存在')
  const pending = { ...session, status: 'pending' as const, error: undefined, errorCode: undefined, updatedAt: new Date().toISOString() }
  await db.readingSessions.put(pending)
  await markPayloadChanged('readingSessions', pending, pending.updatedAt)
  return generateRoundPractice(sessionId)
}

export async function resumePendingPracticePreload(): Promise<void> {
  const pending = await db.readingSessions.filter((session) => session.contentKind === 'round-practice'
    && (session.status === 'pending' || session.status === 'streaming')).toArray()
  await Promise.all(pending.map((session) => generateRoundPractice(session.sessionId).catch(() => undefined)))
}

export async function loadPracticeQuestions(sessionId: string): Promise<PracticeQuestion[]> {
  const session = await db.readingSessions.get(sessionId)
  return session ? parseQuestions(session) : []
}

export async function recordPracticeAnswer(
  sessionId: string,
  question: PracticeQuestion,
  selectedOptionIndex: number | undefined,
  dailySessionId: string,
  roundIndex: number,
  evidence: { responseMs?: number; hintLevel?: number } = {},
): Promise<ContextAttempt> {
  const result: ContextAttempt['result'] = selectedOptionIndex === undefined
    ? 'uncertain'
    : selectedOptionIndex === question.correctIndex ? 'correct' : 'wrong'
  const attempt: ContextAttempt = {
    attemptId: `${sessionId}:${question.questionId}`,
    sessionId,
    wordId: question.focusWordId,
    questionId: question.questionId,
    questionType: question.type,
    selectedOptionIndex,
    correctOptionIndex: question.correctIndex,
    roundIndex,
    result,
    responseMs: evidence.responseMs,
    hintLevel: evidence.hintLevel ?? question.hintLevel ?? 0,
    skill: question.type === 'usage-discrimination' ? 'production' : 'context-sense',
    answeredAt: new Date().toISOString(),
  }
  return recordContextLearningEvidence(attempt, dailySessionId)
}

export async function completeRoundPractice(sessionId: string, skipped = false): Promise<void> {
  const session = await db.readingSessions.get(sessionId)
  if (!session) return
  const now = new Date().toISOString()
  const updated: ReadingSession = skipped
    ? { ...session, status: 'skipped', skippedAt: now, updatedAt: now }
    : { ...session, status: 'completed', updatedAt: now }
  await db.readingSessions.put(updated)
  await markPayloadChanged('readingSessions', updated, now)
}
