import dayjs from 'dayjs'
import { db } from '../../db/database'
import type {
  AppSettings,
  ContextAttempt,
  ReadingSegment,
  ReadingSession,
  ReadingTarget,
  ReadingErrorCode,
  ReviewLog,
} from '../../types/models'
import { normalizeReviewRating } from '../review/scheduler'
import { loadSettings } from '../settings/settingsService'
import { markPayloadChanged, markRecordDeleted } from '../sync/localSyncStore'
import { parseJsonArray } from '../../utils/json'
import { enqueueContextRetry } from '../review/dailyQueueService'
import { dictionaryEntryFromWordbook, isUsableVocabularyHeadword, repairVocabularyIntegrity } from '../wordbook/vocabularyIntegrity'
import { createDeepseekRequest } from '../ai/deepseekRequest'
import { runWithGenerationLock } from '../ai/generationLock'
import { articleLemmaCandidates, canonicalArticleForm, loadArticleInflectionIndex } from './inflectionService'

interface AiReadingResponse {
  title?: string
  segments?: ReadingSegment[]
  targets?: ReadingTarget[]
  translation?: string
}

interface ActiveGeneration {
  promise: Promise<ReadingSession>
  listeners: Set<(progress: StreamProgress) => void>
  lastProgress?: StreamProgress
  abortController: AbortController
}

const activeGenerations = new Map<string, ActiveGeneration>()
export const MAX_READING_BATCH_SIZE = 12

export class ReadingGenerationError extends Error {
  public readonly code: ReadingErrorCode

  public constructor(message: string, code: ReadingErrorCode) {
    super(message)
    this.name = 'ReadingGenerationError'
    this.code = code
  }
}

function readingError(message: string, code: ReadingErrorCode): ReadingGenerationError {
  return new ReadingGenerationError(message, code)
}

function errorCodeOf(error: unknown, fallback: ReadingErrorCode = 'unknown'): ReadingErrorCode {
  if (error instanceof ReadingGenerationError) return error.code
  return fallback
}

function isUsableHeadword(value: string | undefined): value is string {
  return isUsableVocabularyHeadword(value)
}

function headwordFromEntryId(entryId: string): string | undefined {
  return entryId.split(':').reverse().find((part) => /^[a-z][a-z' -]{1,79}$/i.test(part))
}

function cachedSessionHasValidTargets(session: ReadingSession, expectedWordIds?: string[]): boolean {
  try {
    const targets = JSON.parse(session.targetsJson) as ReadingTarget[]
    const segments = JSON.parse(session.segmentsJson) as ReadingSegment[]
    const visible = [session.title, session.translation, ...segments.map((segment) => segment.text)].join(' ')
    const coveredWordIds = new Set(segments.flatMap((segment) => segment.wordId ? [segment.wordId] : []))
    const cachedSource = session.sourceWordIds ?? [...session.targetWordIds, ...(session.omittedTargetWordIds ?? [])]
    const expectedMatches = !expectedWordIds
      || (cachedSource.length === expectedWordIds.length && expectedWordIds.every((wordId) => cachedSource.includes(wordId)))
    return !/[0-9a-f]{8}-[0-9a-f-]{27,}/i.test(visible)
      && targets.length > 0
      && targets.every((target) => isUsableHeadword(target.headword) && target.headword !== target.wordId)
      && session.targetWordIds.every((wordId) => coveredWordIds.has(wordId))
      && expectedMatches
  } catch { return false }
}

function cachedPassage(session: ReadingSession | undefined): string {
  if (!session) return ''
  try {
    return (JSON.parse(session.segmentsJson) as ReadingSegment[]).map((segment) => segment.text).join('').trim()
  } catch {
    return ''
  }
}

function hash(input: string): number {
  let value = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index)
    value = Math.imul(value, 16777619)
  }
  return value >>> 0
}

export async function buildReadingTargetBatches(dayKey = dayjs().format('YYYY-MM-DD'), seed = 0): Promise<string[][]> {
  const start = dayjs(dayKey).startOf('day').toISOString()
  const end = dayjs(dayKey).endOf('day').toISOString()
  const logs = await db.reviewLogs.where('reviewedAt').between(start, end, true, true).toArray()
  const flashcardLogs = logs.filter((log) => (log.source ?? 'flashcard') === 'flashcard')
  const byWord = new Map<string, ReviewLog[]>()
  for (const log of flashcardLogs) {
    const bucket = byWord.get(log.wordId) ?? []
    bucket.push(log)
    byWord.set(log.wordId, bucket)
  }

  const mandatory: string[] = []
  const goodOnly: string[] = []
  for (const [wordId, wordLogs] of byWord) {
    const ratings = wordLogs.map((log) => normalizeReviewRating(log.rating))
    if (wordLogs.some((log) => log.wasNew) || ratings.some((rating) => rating === 'again' || rating === 'hard')) {
      mandatory.push(wordId)
    } else if (ratings.length > 0 && ratings.every((rating) => rating === 'good')) {
      goodOnly.push(wordId)
    }
  }
  goodOnly.sort((a, b) => hash(`${dayKey}:${seed}:${a}`) - hash(`${dayKey}:${seed}:${b}`))
  const sampledGood = goodOnly.slice(0, Math.ceil(goodOnly.length * 0.25))
  const selected = [...new Set([...mandatory, ...sampledGood])]
  selected.sort((a, b) => hash(`${dayKey}:batch:${a}`) - hash(`${dayKey}:batch:${b}`))
  if (selected.length <= MAX_READING_BATCH_SIZE) return selected.length ? [selected] : []
  const batchCount = Math.ceil(selected.length / MAX_READING_BATCH_SIZE)
  const batches: string[][] = Array.from({ length: batchCount }, () => [])
  selected.forEach((wordId, index) => batches[index % batchCount]!.push(wordId))
  return batches
}

function normalizeReadingBatches(raw: unknown): string[][] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((batch): batch is unknown[] => Array.isArray(batch))
    .map((batch) => [...new Set(batch.filter((wordId): wordId is string => typeof wordId === 'string' && wordId.trim().length > 0))])
    .filter((batch) => batch.length > 0)
}

function parseReadingBatches(raw: string | undefined): string[][] {
  if (!raw) return []
  try { return normalizeReadingBatches(JSON.parse(raw)) } catch { return [] }
}

function roundReadingBatches(raw: string | undefined, roundsPerArticle: number): string[][] {
  if (!raw) return []
  try {
    const rounds = JSON.parse(raw) as Array<{ wordIds?: unknown }>
    if (!Array.isArray(rounds)) return []
    const words = rounds.map((round) => Array.isArray(round.wordIds)
      ? round.wordIds.filter((wordId): wordId is string => typeof wordId === 'string')
      : [])
    const batches: string[][] = []
    for (let index = 0; index < words.length; index += roundsPerArticle) {
      const group = [...new Set(words.slice(index, index + roundsPerArticle).flat())]
      for (let offset = 0; offset < group.length; offset += MAX_READING_BATCH_SIZE) {
        batches.push(group.slice(offset, offset + MAX_READING_BATCH_SIZE))
      }
    }
    return batches
  } catch { return [] }
}

export async function persistReadingBatches(
  sessionId: string,
  batches: string[][],
  activeBatchIndex?: number,
): Promise<string[][]> {
  const session = await db.dailyLearningSessions.get(sessionId)
  if (!session) return batches
  const settings = await loadSettings()
  const normalized = normalizeReadingBatches(batches)
  const index = normalized.length
    ? Math.max(0, Math.min(activeBatchIndex ?? session.activeReadingBatchIndex ?? 0, normalized.length - 1))
    : 0
  const updated = {
    ...session,
    readingBatchesJson: JSON.stringify(normalized),
    readingBatchRounds: settings.articleEveryRounds,
    activeReadingBatchIndex: index,
    updatedAt: new Date().toISOString(),
  }
  await db.dailyLearningSessions.put(updated)
  await markPayloadChanged('dailyLearningSessions', updated, updated.updatedAt)
  return normalized
}

export async function getOrCreateReadingBatches(
  sessionId: string,
  dayKey = dayjs().format('YYYY-MM-DD'),
  seed = 0,
): Promise<string[][]> {
  const session = await db.dailyLearningSessions.get(sessionId)
  const settings = await loadSettings()
  const cached = session?.articleStatus !== 'stale' ? parseReadingBatches(session?.readingBatchesJson) : []
  const roundBatches = roundReadingBatches(session?.roundsJson, settings.articleEveryRounds)
  const cadenceChanged = session?.readingBatchRounds !== undefined && session.readingBatchRounds !== settings.articleEveryRounds
  if (cadenceChanged && roundBatches.length) return persistReadingBatches(sessionId, roundBatches, session?.activeReadingBatchIndex)
  if (roundBatches.length > cached.length) return persistReadingBatches(sessionId, roundBatches, session?.activeReadingBatchIndex)
  if (cached.length) return cached
  if (roundBatches.length) return persistReadingBatches(sessionId, roundBatches, session?.activeReadingBatchIndex)
  return persistReadingBatches(sessionId, await buildReadingTargetBatches(dayKey, seed), session?.activeReadingBatchIndex)
}

export async function appendOmittedReadingTargets(
  sessionId: string,
  batchIndex: number,
  omittedWordIds: string[],
): Promise<string[][]> {
  const session = await db.dailyLearningSessions.get(sessionId)
  const batches = parseReadingBatches(session?.readingBatchesJson)
  if (!session || !batches.length || !omittedWordIds.length) return batches
  const nextIndex = batchIndex + 1
  const combined = [...new Set([...omittedWordIds, ...(batches[nextIndex] ?? [])])]
  const chunks: string[][] = []
  for (let index = 0; index < combined.length; index += MAX_READING_BATCH_SIZE) {
    chunks.push(combined.slice(index, index + MAX_READING_BATCH_SIZE))
  }
  batches.splice(nextIndex, 1, ...chunks)
  return persistReadingBatches(sessionId, batches, batchIndex)
}

export async function setActiveReadingBatch(sessionId: string, batchIndex: number): Promise<void> {
  const session = await db.dailyLearningSessions.get(sessionId)
  if (!session) return
  const batches = parseReadingBatches(session.readingBatchesJson)
  const activeBatchIndex = batches.length ? Math.max(0, Math.min(batchIndex, batches.length - 1)) : 0
  const updated = { ...session, activeReadingBatchIndex: activeBatchIndex, updatedAt: new Date().toISOString() }
  await db.dailyLearningSessions.put(updated)
  await markPayloadChanged('dailyLearningSessions', updated, updated.updatedAt)
}

type ReadingPromptRow = { wordId: string; headword: string; senses: string[]; posList?: string[] }

function validateResponse(response: AiReadingResponse, rows: ReadingPromptRow[]): asserts response is Required<AiReadingResponse> {
  if (!response.title || !response.translation || !Array.isArray(response.segments) || !Array.isArray(response.targets)) {
    throw readingError('AI 返回的文章结构不完整', 'details-invalid')
  }
  const expected = new Set(rows.map((row) => row.wordId))
  const rowById = new Map(rows.map((row) => [row.wordId, row]))
  const visibleText = [response.title, response.translation, ...response.segments.map((segment) => segment.text)].join(' ')
  if (/[0-9a-f]{8}-[0-9a-f-]{27,}/i.test(visibleText)) throw readingError('AI 文章包含了内部标识符，请重新生成', 'passage-invalid')
  const segmentIds = new Set(response.segments.map((segment) => segment.wordId).filter(Boolean))
  const targetIds = new Set(response.targets.map((target) => target.wordId))
  for (const wordId of expected) {
    if (!segmentIds.has(wordId) || !targetIds.has(wordId)) throw readingError('AI 文章未覆盖全部目标词', 'passage-invalid')
  }
  for (const target of response.targets) {
    const row = rowById.get(target.wordId)
    if (!row || !isUsableHeadword(target.headword) || !targetUsesAllowedSense(target, row) || !hasDistinctChoices(target)) {
      throw readingError('AI 测义选项不符合要求', 'details-invalid')
    }
  }
}

function normalizeChoice(value: string): string {
  return value.toLowerCase().replace(/[\s，。；、,.!?！？：:（）()“”"']/g, '')
}

function meaningsTooSimilar(left: string, right: string): boolean {
  if (!left || !right) return true
  const shorter = left.length <= right.length ? left : right
  const longer = left.length > right.length ? left : right
  if (shorter.length >= 2 && shorter.slice(0, 2) === longer.slice(0, 2)) return true
  if (shorter.length >= 2 && longer.includes(shorter) && shorter.length / longer.length >= 0.65) return true
  const leftChars = new Set(left)
  const rightChars = new Set(right)
  const overlap = [...leftChars].filter((char) => rightChars.has(char)).length
  const union = new Set([...leftChars, ...rightChars]).size
  return union > 0 && overlap / union >= 0.72
}

function targetUsesAllowedSense(target: ReadingTarget, row: ReadingPromptRow): boolean {
  if (!row.senses.length) return true
  const selected = normalizeChoice(target.sourceSense ?? '')
  const contextual = normalizeChoice(target.contextualMeaning)
  return row.senses.some((sense) => {
    const normalized = normalizeChoice(sense)
    return selected === normalized || (!selected && (normalized === contextual || normalized.includes(contextual)))
  })
}

type ChoiceValidationFailure = 'structure' | 'duplicate' | 'too-similar' | undefined

function choiceValidationFailure(target: ReadingTarget): ChoiceValidationFailure {
  if (!Array.isArray(target.choices) || target.choices.length !== 3) return 'structure'
  const normalizedChoices = target.choices.map(normalizeChoice)
  const correct = normalizeChoice(target.contextualMeaning)
  if (new Set(normalizedChoices).size !== 3 || !normalizedChoices.includes(correct)) return 'duplicate'
  for (let left = 0; left < normalizedChoices.length; left += 1) {
    for (let right = left + 1; right < normalizedChoices.length; right += 1) {
      if (meaningsTooSimilar(normalizedChoices[left]!, normalizedChoices[right]!)) return 'too-similar'
    }
  }
  return undefined
}

function hasDistinctChoices(target: ReadingTarget): boolean {
  return choiceValidationFailure(target) === undefined
}

function buildArticlePrompt(
  rows: ReadingPromptRow[],
  level: AppSettings['articleLevel'],
  topic: string,
): string {
  return `Create one coherent English reading passage at CEFR ${level}${topic ? ` about ${topic}` : ''} and all of its vocabulary questions in one streamed response.
Use every target naturally when possible. A common inflected form is allowed when grammar requires it, but never replace a target with a derivationally different word.
For each target that actually appears, select exactly one sourceSense from its allowedSenses and create one Chinese meaning question.
TARGETS: ${JSON.stringify(rows.map((row) => ({ wordId: row.wordId, headword: row.headword, allowedSenses: row.senses })))}
Output newline-delimited JSON only, one complete object per line, in this order:
{"type":"meta","title":"concise English title"}
{"type":"paragraph","text":"one complete English paragraph"} (2-5 lines)
{"type":"target","wordId":"exact target id","headword":"exact target headword","sourceSense":"exactly one allowed sense used in the passage","contextualMeaning":"concise Simplified Chinese meaning","choices":["exactly three distinct Simplified Chinese choices including contextualMeaning"],"explanation":"concise explanation tied to the passage"} (one line for every target that appears)
{"type":"translation","text":"complete Simplified Chinese translation"}
{"type":"done"}
Do not output markdown. Never expose target IDs in visible prose. Distractors must share the same part of speech but be clearly wrong from context; avoid near-synonyms, trick distinctions, specialist knowledge, and current-event claims.`
}

export function readingBatchRangeForRound(
  raw: string | undefined,
  roundIndex: number,
  roundsPerArticle: number,
): { start: number; end: number } {
  if (!raw || roundIndex < 1) return { start: 0, end: 0 }
  try {
    const rounds = JSON.parse(raw) as Array<{ index?: number; wordIds?: unknown }>
    if (!Array.isArray(rounds)) return { start: 0, end: 0 }
    const groupStart = Math.floor((roundIndex - 1) / roundsPerArticle) * roundsPerArticle + 1
    let start = 0
    for (let index = 1; index < groupStart; index += roundsPerArticle) {
      const count = new Set(rounds
        .filter((round) => (round.index ?? 0) >= index && (round.index ?? 0) < index + roundsPerArticle)
        .flatMap((round) => Array.isArray(round.wordIds) ? round.wordIds.filter((wordId): wordId is string => typeof wordId === 'string') : [])).size
      start += Math.ceil(count / MAX_READING_BATCH_SIZE)
    }
    const currentCount = new Set(rounds
      .filter((round) => (round.index ?? 0) >= groupStart && (round.index ?? 0) < groupStart + roundsPerArticle)
      .flatMap((round) => Array.isArray(round.wordIds) ? round.wordIds.filter((wordId): wordId is string => typeof wordId === 'string') : [])).size
    return { start, end: start + Math.max(1, Math.ceil(currentCount / MAX_READING_BATCH_SIZE)) - 1 }
  } catch { return { start: 0, end: 0 } }
}

function buildFallbackDetails(
  rows: ReadingPromptRow[],
): Pick<Required<AiReadingResponse>, 'title' | 'targets' | 'translation'> {
  const distractorPool = ['进行计算操作', '表示时间顺序', '一种具体地点', '某种食物名称', '描述声音强弱']
  const targets = rows.map((row) => {
    const contextualMeaning = row.senses.find(Boolean) ?? '请结合上下文理解该词'
    const samePartOfSpeech = rows
      .filter((candidate) => candidate.wordId !== row.wordId
        && (!row.posList?.length || !candidate.posList?.length || candidate.posList.some((part) => row.posList!.includes(part))))
      .flatMap((candidate) => candidate.senses)
    const distractors = [...samePartOfSpeech, ...distractorPool]
      .filter((choice) => normalizeChoice(choice) !== normalizeChoice(contextualMeaning) && !meaningsTooSimilar(choice, contextualMeaning))
      .filter((choice, index, choices) => choices.indexOf(choice) === index)
      .slice(0, 2)
    return {
      wordId: row.wordId,
      headword: row.headword,
      sourceSense: contextualMeaning,
      contextualMeaning,
      choices: [contextualMeaning, ...distractors],
      explanation: '题目服务暂时未完成，已使用本地词典释义生成备用题目。',
    }
  })
  return {
    title: 'Context Reading',
    targets,
    translation: '题目服务暂时不可用，本次保留英文正文和备用测义题。',
  }
}

export type StreamProgress = {
  phase: 'article' | 'details'
  rawText: string
  paragraphs: string[]
  targetCount: number
}

function splitPassage(raw: string): string[] {
  const normalized = raw.replace(/^```(?:text|english)?\s*/i, '').replace(/```\s*$/i, '').trim()
  return normalized ? normalized.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean) : []
}

function passageIncludesHeadword(passage: string, headword: string, inflections: Record<string, string> = {}): boolean {
  return targetMatchPosition(passage, headword, inflections) >= 0
}

function normalizedMatchText(value: string): string {
  return value.toLowerCase().replace(/[‘’]/g, "'").replace(/[‐‑‒–—]/g, '-')
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
}

function targetMatchPosition(passage: string, headword: string, inflections: Record<string, string> = {}): number {
  return findTargetMatches(passage, [{ wordId: '', headword, contextualMeaning: '', choices: [], explanation: '' }], inflections)[0]?.position ?? -1
}

type TargetTextMatch = { position: number; length: number; text: string; target: ReadingTarget }

function findTargetMatches(passage: string, targets: ReadingTarget[], inflections: Record<string, string> = {}): TargetTextMatch[] {
  const ordered = [...targets].sort((left, right) => right.headword.length - left.headword.length)
  const pattern = ordered.map((target) => escapePattern(normalizedMatchText(target.headword))).join('|')
  if (!pattern) return []
  const normalizedPassage = normalizedMatchText(passage)
  const regex = new RegExp(`(^|[^A-Za-z])(${pattern})(?=$|[^A-Za-z])`, 'gi')
  const matches: TargetTextMatch[] = []
  for (const match of normalizedPassage.matchAll(regex)) {
    const matchedWord = match[2] ?? ''
    const target = ordered.find((row) => normalizedMatchText(row.headword) === matchedWord.toLowerCase())
    if (!target) continue
    matches.push({ position: (match.index ?? 0) + (match[1]?.length ?? 0), length: matchedWord.length, text: passage.slice((match.index ?? 0) + (match[1]?.length ?? 0), (match.index ?? 0) + (match[1]?.length ?? 0) + matchedWord.length), target })
  }
  if (!Object.keys(inflections).length) return matches
  const occupied = new Set(matches.map((match) => `${match.position}:${match.length}`))
  const targetByLemma = new Map(targets.map((target) => [canonicalArticleForm(target.headword, inflections), target]))
  for (const match of passage.matchAll(/[A-Za-z]+(?:['-][A-Za-z]+)*/g)) {
    const text = match[0]
    const position = match.index ?? 0
    const target = articleLemmaCandidates(text, inflections).map((lemma) => targetByLemma.get(lemma)).find(Boolean)
    if (!target || occupied.has(`${position}:${text.length}`)) continue
    matches.push({ position, length: text.length, text, target })
  }
  matches.sort((left, right) => left.position - right.position || right.length - left.length)
  return matches
}

export function sortTargetsByPassageOrder(targets: ReadingTarget[], passage: string, inflections: Record<string, string> = {}): ReadingTarget[] {
  const firstPositions = new Map<string, number>()
  for (const match of findTargetMatches(passage, targets, inflections)) {
    if (!firstPositions.has(match.target.wordId)) firstPositions.set(match.target.wordId, match.position)
  }
  return targets
    .map((target, index) => ({
      target,
      index,
      position: firstPositions.get(target.wordId) ?? -1,
    }))
    .sort((left, right) => {
      const leftPosition = left.position < 0 ? Number.MAX_SAFE_INTEGER : left.position
      const rightPosition = right.position < 0 ? Number.MAX_SAFE_INTEGER : right.position
      return leftPosition - rightPosition || left.index - right.index
    })
    .map(({ target }) => target)
}

function apiError(status: number): ReadingGenerationError {
  const messages: Record<number, string> = { 401: 'DeepSeek Key 无效，请到设置中更新', 402: 'DeepSeek 余额不足，请充值后重试', 429: '请求过多，请稍后重试' }
  const code: ReadingErrorCode = status === 401 ? 'auth' : status === 402 ? 'quota' : status === 429 ? 'rate-limit' : status >= 500 ? 'network' : 'unknown'
  return readingError(messages[status] ?? (status >= 500 ? 'DeepSeek 服务暂时不可用，请稍后重试' : `文章生成失败（HTTP ${status}）`), code)
}

function buildSegments(paragraphs: string[], targets: ReadingTarget[], inflections: Record<string, string> = {}): ReadingSegment[] {
  if (!targets.length) return [{ text: paragraphs.join('\n\n') }]
  return paragraphs.flatMap((paragraph, paragraphIndex) => {
    const segments: ReadingSegment[] = []
    let cursor = 0
    for (const match of findTargetMatches(paragraph, targets, inflections)) {
      if (match.position > cursor) segments.push({ text: paragraph.slice(cursor, match.position) })
      segments.push({ text: paragraph.slice(match.position, match.position + match.length), wordId: match.target.wordId })
      cursor = match.position + match.length
    }
    segments.push({ text: `${paragraph.slice(cursor)}${paragraphIndex < paragraphs.length - 1 ? '\n\n' : ''}` })
    return segments
  })
}

export function groupReadingSegmentsByParagraph(segments: ReadingSegment[]): ReadingSegment[][] {
  const paragraphs: ReadingSegment[][] = [[]]
  for (const segment of segments) {
    const text = segment.text
    let cursor = 0
    for (const separator of text.matchAll(/\n\s*\n/g)) {
      const index = separator.index ?? cursor
      const current = paragraphs[paragraphs.length - 1]!
      if (index > cursor) current.push({ ...segment, text: text.slice(cursor, index) })
      if (current.length) paragraphs.push([])
      cursor = index + separator[0].length
    }
    if (cursor < text.length) paragraphs[paragraphs.length - 1]!.push({ ...segment, text: text.slice(cursor) })
  }
  return paragraphs.filter((paragraph) => paragraph.some((segment) => segment.text.length > 0))
}

async function requestArticle(
  settings: AppSettings,
  prompt: string,
  onProgress?: (progress: StreamProgress) => void,
  externalSignal?: AbortSignal,
): Promise<{ title: string; passage: string; targets: ReadingTarget[]; translation: string }> {
  if (!settings.deepseekApiKey.trim()) throw readingError('请先在设置页填写 DeepSeek API Key', 'missing-key')
  const controller = new AbortController()
  externalSignal?.addEventListener('abort', () => controller.abort(), { once: true })
  let timeoutMessage = ''
  let receivedFirst = false
  let stallTimer = 0
  const resetStall = () => {
    window.clearTimeout(stallTimer)
    stallTimer = window.setTimeout(() => {
      timeoutMessage = receivedFirst ? '文章流已中断 20 秒，请重试' : '20 秒内未收到文章片段，请重试'
      controller.abort()
    }, 20_000)
  }
  const totalTimer = window.setTimeout(() => {
    timeoutMessage = '文章生成超过 120 秒，已自动停止'
    controller.abort()
  }, 120_000)
  resetStall()
  try {
    const response = await fetch(settings.deepseekBaseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.deepseekApiKey.trim()}` },
      body: JSON.stringify(createDeepseekRequest({
        model: settings.deepseekModel,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
        maxTokens: 6200,
      })),
      signal: controller.signal,
    })
    if (!response.ok) throw apiError(response.status)
    if (!response.body) throw readingError('浏览器无法读取流式响应', 'network')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let sseBuffer = ''
    let ndjsonBuffer = ''
    let title = ''
    const paragraphs: string[] = []
    const targets: ReadingTarget[] = []
    let translation = ''
    const consumeLine = (line: string) => {
      const trimmed = line.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '')
      if (!trimmed) return
      const event = JSON.parse(trimmed) as Record<string, unknown>
      if (event.type === 'meta') title = String(event.title ?? '')
      if (event.type === 'paragraph') paragraphs.push(String(event.text ?? ''))
      if (event.type === 'target') targets.push(event as unknown as ReadingTarget)
      if (event.type === 'translation') translation = String(event.text ?? '')
      const passage = paragraphs.join('\n\n')
      onProgress?.({ phase: targets.length ? 'details' : 'article', rawText: passage, paragraphs: [...paragraphs], targetCount: targets.length })
    }
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      receivedFirst = true
      resetStall()
      sseBuffer += decoder.decode(value, { stream: true })
      const sseLines = sseBuffer.split(/\r?\n/)
      sseBuffer = sseLines.pop() ?? ''
      for (const line of sseLines) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        const payload = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }
        ndjsonBuffer += payload.choices?.[0]?.delta?.content ?? ''
        const eventLines = ndjsonBuffer.split(/\r?\n/)
        ndjsonBuffer = eventLines.pop() ?? ''
        for (const eventLine of eventLines) consumeLine(eventLine)
      }
    }
    if (ndjsonBuffer.trim()) consumeLine(ndjsonBuffer)
    const passage = paragraphs.map((paragraph) => paragraph.trim()).filter(Boolean).join('\n\n')
    if (!passage) throw readingError('AI 没有返回文章正文', 'passage-invalid')
    if (!title || !translation) throw readingError('AI 返回的文章结构不完整', 'details-invalid')
    return { title, passage, targets, translation }
  } catch (error) {
    if (timeoutMessage) throw readingError(timeoutMessage, 'timeout')
    if (externalSignal?.aborted) throw readingError('已取消文章生成', 'cancelled')
    if (error instanceof ReadingGenerationError) throw error
    if (error instanceof SyntaxError) throw readingError('文章流格式异常，请重试', 'details-invalid')
    if (error instanceof TypeError) throw readingError('无法连接文章服务，请检查网络后重试', 'network')
    throw error
  } finally {
    window.clearTimeout(stallTimer)
    window.clearTimeout(totalTimer)
  }
}

async function generateReadingSessionImpl(options: {
  dayKey: string
  batchIndex: number
  seed: number
  wordIds: string[]
  level?: AppSettings['articleLevel']
  topic?: string
  force?: boolean
  onProgress?: (progress: StreamProgress) => void
  signal?: AbortSignal
}): Promise<ReadingSession> {
  const sessionId = `reading:${options.dayKey}:${options.seed}:${options.batchIndex}`
  const existing = await db.readingSessions.get(sessionId)
  const inflections = await loadArticleInflectionIndex()
  if ((existing?.status === 'ready' || existing?.status === 'completed') && !options.force && cachedSessionHasValidTargets(existing, options.wordIds)) {
    const cachedTargets = JSON.parse(existing.targetsJson) as ReadingTarget[]
    const orderedTargets = sortTargetsByPassageOrder(cachedTargets, cachedPassage(existing), inflections)
    const orderedWordIds = orderedTargets.map((target) => target.wordId)
    if (orderedWordIds.some((wordId, index) => wordId !== existing.targetWordIds[index])) {
      const normalized = {
        ...existing,
        targetWordIds: orderedWordIds,
        targetsJson: JSON.stringify(orderedTargets),
        updatedAt: new Date().toISOString(),
      }
      await db.readingSessions.put(normalized)
      await markPayloadChanged('readingSessions', normalized)
      return normalized
    }
    return existing
  }
  const settings = await loadSettings()
  const level = options.level ?? settings.articleLevel
  await repairVocabularyIntegrity(options.wordIds)
  const words = await db.wordbook.bulkGet(options.wordIds)
  const entries = await db.dictionaryEntries.bulkGet(words.map((word) => word?.entryId ?? ''))
  const promptRows: ReadingPromptRow[] = []
  for (const [index, wordId] of options.wordIds.entries()) {
    const word = words[index]
    let entry = entries[index] ?? (word ? dictionaryEntryFromWordbook(word) : undefined)
    if (!entry && word) {
      const inferred = headwordFromEntryId(word.entryId)
      if (inferred) entry = await db.dictionaryEntries.where('headwordLower').equals(inferred.toLowerCase()).first()
      if (entry && entry.entryId !== word.entryId) {
        const repaired = { ...word, entryId: entry.entryId }
        await db.wordbook.put(repaired)
        await markPayloadChanged('wordbook', repaired)
      }
    }
    if (!entry || !isUsableHeadword(entry.headword)) continue
    promptRows.push({ wordId, headword: entry.headword, senses: parseJsonArray(entry.sensesJson).slice(0, 4), posList: entry.posList })
  }
  const validWordIds = promptRows.map((row) => row.wordId)
  const now = new Date().toISOString()
  // A partial legacy two-step generation cannot be resumed safely. Restart the
  // single article bundle; ready/completed sessions returned from the cache above.
  const reusablePassage = ''
  let session: ReadingSession = {
    sessionId,
    dayKey: options.dayKey,
    batchIndex: options.batchIndex,
    selectionSeed: options.seed,
    level,
    topic: options.topic?.trim() ?? '',
    contentKind: 'article',
    sourceWordIds: [...options.wordIds],
    sourceWordSetHash: String(hash(JSON.stringify(options.wordIds))),
    promptVersion: 'article-single-stream-v1',
    targetWordIds: validWordIds,
    omittedTargetWordIds: [],
    generationAttemptCount: (existing?.generationAttemptCount ?? 0) + 1,
    successfulGenerationCount: existing?.successfulGenerationCount ?? 0,
    lastGeneratedAt: now,
    status: reusablePassage ? 'enriching' : 'streaming',
    segmentsJson: reusablePassage ? JSON.stringify([{ text: reusablePassage }]) : '[]',
    targetsJson: '[]',
    translation: '',
    errorCode: undefined,
    createdAt: existing?.createdAt ?? now,
    readerStage: existing?.readerStage ?? 0,
    quizCursor: existing?.quizCursor ?? 0,
    resultCursor: existing?.resultCursor ?? 0,
    showTranslation: existing?.showTranslation ?? false,
    updatedAt: now,
  }
  await db.readingSessions.put(session)
  await markPayloadChanged('readingSessions', session, session.updatedAt)
  let latestPassage = ''
  let checkpointTimer = 0
  const persistStreamingCheckpoint = async () => {
    if (!latestPassage || session.status !== 'streaming') return
    const updated = {
      ...session,
      segmentsJson: JSON.stringify([{ text: latestPassage }]),
      streamedParagraphs: splitPassage(latestPassage).length,
      updatedAt: new Date().toISOString(),
    }
    session = updated
    await db.readingSessions.put(updated)
    await markPayloadChanged('readingSessions', updated, updated.updatedAt)
  }
  const onPassageProgress = (progress: StreamProgress) => {
    latestPassage = progress.rawText
    options.onProgress?.(progress)
    if (checkpointTimer) return
    checkpointTimer = window.setTimeout(() => {
      checkpointTimer = 0
      void persistStreamingCheckpoint()
    }, 350)
  }
  try {
    if (!validWordIds.length) throw readingError('今天的目标词资料不完整，请重新查词或安装词典后重试', 'passage-invalid')
    let article: Awaited<ReturnType<typeof requestArticle>> | undefined
    let articleError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        article = await requestArticle(settings, buildArticlePrompt(promptRows, level, session.topic), onPassageProgress, options.signal)
        break
      } catch (error) {
        articleError = error
        if (options.signal?.aborted || errorCodeOf(error) === 'missing-key' || errorCodeOf(error) === 'cancelled') break
        if (attempt === 0) await new Promise((resolve) => window.setTimeout(resolve, 2_000))
      }
    }
    if (!article) throw articleError
    const passage = article.passage
    const passageRows = promptRows.filter((row) => passageIncludesHeadword(passage, row.headword, inflections))
    if (!passageRows.length) throw readingError('正文没有覆盖任何目标词', 'passage-invalid')
    if (checkpointTimer) {
      window.clearTimeout(checkpointTimer)
      checkpointTimer = 0
    }
    latestPassage = passage
    await persistStreamingCheckpoint()
    const expectedHeadwords = new Map(passageRows.map((row) => [row.wordId, row.headword]))
    const seenTargetIds = new Set<string>()
    const usableTargets = article.targets.filter((target) => {
      if (!expectedHeadwords.has(target.wordId) || seenTargetIds.has(target.wordId)) return false
      seenTargetIds.add(target.wordId)
      return Boolean(target.contextualMeaning && Array.isArray(target.choices))
    })
    const generated: AiReadingResponse = {
      title: article.title,
      translation: article.translation,
      targets: usableTargets,
      segments: buildSegments(splitPassage(passage), usableTargets, inflections),
    }
    generated.targets = generated.targets?.map((target) => {
      const headword = expectedHeadwords.get(target.wordId) ?? target.headword
      const surfaceForm = findTargetMatches(passage, [{ ...target, headword }], inflections)[0]?.text
      return {
        ...target,
        headword,
        surfaceForm: surfaceForm && normalizedMatchText(surfaceForm) !== normalizedMatchText(headword) ? surfaceForm : undefined,
        choices: [...target.choices].sort((left, right) => hash(`${sessionId}:${target.wordId}:${left}`) - hash(`${sessionId}:${target.wordId}:${right}`)),
      }
    })
    const fallback = buildFallbackDetails(passageRows)
    const rowByWordId = new Map(passageRows.map((row) => [row.wordId, row]))
    const validTargets = new Map((generated.targets ?? [])
      .filter((target) => hasDistinctChoices(target) && Boolean(rowByWordId.get(target.wordId) && targetUsesAllowedSense(target, rowByWordId.get(target.wordId)!)))
      .map((target) => [target.wordId, target]))
    generated.title = generated.title || fallback.title
    generated.translation = generated.translation || fallback.translation
    const completedTargets = passageRows.map((row) => validTargets.get(row.wordId)
      ?? fallback.targets.find((target) => target.wordId === row.wordId)!).filter(Boolean)
    const coveredTargets = sortTargetsByPassageOrder(completedTargets, passage, inflections)
    generated.targets = coveredTargets
    const generatedWordIds = generated.targets.map((target) => target.wordId)
    generated.segments = buildSegments(splitPassage(passage), coveredTargets, inflections)
    validateResponse(generated, passageRows.filter((row) => generatedWordIds.includes(row.wordId)))
    const coveredSet = new Set(coveredTargets.map((target) => target.wordId))
    session = {
      ...session,
      status: 'ready',
      targetWordIds: generatedWordIds,
      omittedTargetWordIds: validWordIds.filter((wordId) => !coveredSet.has(wordId)),
      successfulGenerationCount: (session.successfulGenerationCount ?? 0) + 1,
      title: generated.title,
      segmentsJson: JSON.stringify(generated.segments),
      targetsJson: JSON.stringify(generated.targets),
      translation: generated.translation,
      error: undefined,
      errorCode: undefined,
      updatedAt: new Date().toISOString(),
    }
  } catch (error) {
    if (checkpointTimer) {
      window.clearTimeout(checkpointTimer)
      checkpointTimer = 0
    }
    await persistStreamingCheckpoint()
    session = {
      ...session,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      errorCode: errorCodeOf(error),
      updatedAt: new Date().toISOString(),
    }
  }
  await db.readingSessions.put(session)
  await markPayloadChanged('readingSessions', session, session.updatedAt)
  return session
}

export async function generateReadingSession(options: {
  dayKey: string
  batchIndex: number
  seed: number
  wordIds: string[]
  level?: AppSettings['articleLevel']
  topic?: string
  force?: boolean
  onProgress?: (progress: StreamProgress) => void
  signal?: AbortSignal
}): Promise<ReadingSession> {
  const sessionId = `reading:${options.dayKey}:${options.seed}:${options.batchIndex}`
  const active = activeGenerations.get(sessionId)
  if (active && options.force) {
    active.abortController.abort()
    await active.promise.catch(() => undefined)
  }
  const current = activeGenerations.get(sessionId)
  if (current && !options.force) {
    if (options.onProgress) {
      current.listeners.add(options.onProgress)
      if (current.lastProgress) options.onProgress(current.lastProgress)
    }
    if (!options.signal) return current.promise
    return new Promise<ReadingSession>((resolve, reject) => {
      const detach = () => {
        if (options.onProgress) current.listeners.delete(options.onProgress)
        options.signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = () => { detach(); reject(readingError('已取消文章生成', 'cancelled')) }
      if (options.signal!.aborted) return onAbort()
      options.signal!.addEventListener('abort', onAbort, { once: true })
      current.promise.then((result) => { detach(); resolve(result) }, (error) => { detach(); reject(error) })
    })
  }
  const listeners = new Set<(progress: StreamProgress) => void>()
  if (options.onProgress) listeners.add(options.onProgress)
  const abortController = new AbortController()
  const forwardAbort = () => abortController.abort()
  options.signal?.addEventListener('abort', forwardAbort, { once: true })
  const state = { abortController } as ActiveGeneration
  const onProgress = (progress: StreamProgress) => {
    state.lastProgress = progress
    for (const listener of state.listeners) listener(progress)
  }
  const run = () => generateReadingSessionImpl({ ...options, signal: abortController.signal, onProgress })
  const task = runWithGenerationLock(`wordsbook:generation:${sessionId}`, run).finally(() => {
    options.signal?.removeEventListener('abort', forwardAbort)
    if (activeGenerations.get(sessionId) === state) activeGenerations.delete(sessionId)
  })
  state.promise = task
  state.listeners = listeners
  activeGenerations.set(sessionId, state)
  return task
}

export async function cancelReadingGeneration(sessionId: string): Promise<void> {
  const active = activeGenerations.get(sessionId)
  if (!active) return
  active.abortController.abort()
  await active.promise.catch(() => undefined)
}

export async function preGenerateDailyArticle(dayKey: string, requestedBatchIndex?: number): Promise<ReadingSession | undefined> {
  const settings = await loadSettings()
  if (!settings.deepseekApiKey.trim()) return undefined
  const dailySessionId = `daily:${dayKey}`
  const [batches, dailySession] = await Promise.all([
    getOrCreateReadingBatches(dailySessionId, dayKey),
    db.dailyLearningSessions.get(dailySessionId),
  ])
  const batchIndex = Math.max(0, Math.min(
    requestedBatchIndex ?? dailySession?.activeReadingBatchIndex ?? 0,
    Math.max(0, batches.length - 1),
  ))
  const batch = batches[batchIndex]
  if (!batch?.length) return undefined
  return generateReadingSession({ dayKey, batchIndex, seed: 0, wordIds: batch, level: settings.articleLevel })
}

export async function resumePendingArticlePreload(at = new Date()): Promise<void> {
  const day = dayjs(at).format('YYYY-MM-DD')
  const session = await db.dailyLearningSessions.where('dayKey').equals(day).first()
  if (!session || session.status === 'completed') return
  const settings = await loadSettings()
  if (!settings.deepseekApiKey.trim()) return
  const roundIndex = session.activeRoundIndex ?? 1
  const range = readingBatchRangeForRound(
    session.roundsJson,
    roundIndex,
    Math.max(1, settings.articleEveryRounds),
  )
  await Promise.all(Array.from(
    { length: range.end - range.start + 1 },
    (_, index) => preGenerateDailyArticle(day, range.start + index),
  ))
}

export async function recordContextAttempt(
  sessionId: string,
  target: ReadingTarget,
  selectedMeaning?: string,
  dailySessionId?: string,
): Promise<ContextAttempt> {
  const result: ContextAttempt['result'] = !selectedMeaning
    ? 'uncertain'
    : selectedMeaning === target.contextualMeaning ? 'correct' : 'wrong'
  const now = new Date()
  const attempt: ContextAttempt = {
    attemptId: `${sessionId}:${target.wordId}`,
    sessionId,
    wordId: target.wordId,
    selectedMeaning,
    result,
    answeredAt: now.toISOString(),
  }
  await db.contextAttempts.put(attempt)
  await markPayloadChanged('contextAttempts', attempt, attempt.answeredAt)
  if (result !== 'correct') {
    if (dailySessionId) await enqueueContextRetry(dailySessionId, target.wordId)
  }
  return attempt
}

export async function loadContextAttempts(sessionId: string): Promise<ContextAttempt[]> {
  return db.contextAttempts.where('sessionId').equals(sessionId).toArray()
}

export async function saveReadingProgress(
  sessionId: string,
  readerStage: 0 | 1 | 2,
  showTranslation: boolean,
  quizCursor?: number,
  resultCursor?: number,
): Promise<void> {
  const session = await db.readingSessions.get(sessionId)
  if (!session) return
  const now = new Date().toISOString()
  const updated: ReadingSession = {
    ...session,
    readerStage,
    showTranslation,
    quizCursor: quizCursor ?? session.quizCursor,
    resultCursor: resultCursor ?? session.resultCursor,
    lastOpenedAt: now,
    updatedAt: now,
  }
  await db.readingSessions.put(updated)
  await markPayloadChanged('readingSessions', updated, now)
}

export async function resetReadingSessionAttempts(sessionId: string): Promise<void> {
  const attempts = await db.contextAttempts.where('sessionId').equals(sessionId).toArray()
  await db.contextAttempts.where('sessionId').equals(sessionId).delete()
  const now = new Date().toISOString()
  for (const attempt of attempts) await markRecordDeleted('contextAttempts', attempt.attemptId, now)
}

export async function listReadingHistory(): Promise<ReadingSession[]> {
  return db.readingSessions
    .filter((session) => (session.contentKind ?? 'article') === 'article')
    .toArray()
    .then((sessions) => sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)))
}

export function parseReadingSession(session: ReadingSession): { segments: ReadingSegment[]; targets: ReadingTarget[] } {
  return {
    segments: JSON.parse(session.segmentsJson) as ReadingSegment[],
    targets: JSON.parse(session.targetsJson) as ReadingTarget[],
  }
}

export async function completeReadingSession(sessionId: string): Promise<void> {
  const session = await db.readingSessions.get(sessionId)
  if (session) {
    const completed: ReadingSession = { ...session, status: 'completed', updatedAt: new Date().toISOString() }
    await db.readingSessions.put(completed)
    await markPayloadChanged('readingSessions', completed, completed.updatedAt)
  }
}
