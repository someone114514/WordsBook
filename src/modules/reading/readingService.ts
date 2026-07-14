import dayjs from 'dayjs'
import { db } from '../../db/database'
import type {
  AppSettings,
  ContextAttempt,
  ReadingSegment,
  ReadingSession,
  ReadingTarget,
  ReviewLog,
} from '../../types/models'
import { normalizeReviewRating } from '../review/scheduler'
import { loadSettings } from '../settings/settingsService'
import { markPayloadChanged } from '../sync/localSyncStore'
import { parseJsonArray } from '../../utils/json'
import { enqueueContextRetry } from '../review/dailyQueueService'
import { dictionaryEntryFromWordbook, isUsableVocabularyHeadword, repairVocabularyIntegrity } from '../wordbook/vocabularyIntegrity'

interface AiReadingResponse {
  title?: string
  segments?: ReadingSegment[]
  targets?: ReadingTarget[]
  translation?: string
}

const activeGenerations = new Map<string, Promise<ReadingSession>>()

function isUsableHeadword(value: string | undefined): value is string {
  return isUsableVocabularyHeadword(value)
}

function headwordFromEntryId(entryId: string): string | undefined {
  return entryId.split(':').reverse().find((part) => /^[a-z][a-z' -]{1,79}$/i.test(part))
}

function cachedSessionHasValidTargets(session: ReadingSession): boolean {
  try {
    const targets = JSON.parse(session.targetsJson) as ReadingTarget[]
    const segments = JSON.parse(session.segmentsJson) as ReadingSegment[]
    const visible = [session.title, session.translation, ...segments.map((segment) => segment.text)].join(' ')
    return !/[0-9a-f]{8}-[0-9a-f-]{27,}/i.test(visible)
      && targets.length > 0
      && targets.every((target) => isUsableHeadword(target.headword) && target.headword !== target.wordId)
  } catch { return false }
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
  if (selected.length <= 25) return selected.length ? [selected] : []
  const batchCount = Math.ceil(selected.length / 25)
  const batches: string[][] = Array.from({ length: batchCount }, () => [])
  selected.forEach((wordId, index) => batches[index % batchCount]!.push(wordId))
  return batches
}

function validateResponse(response: AiReadingResponse, wordIds: string[]): asserts response is Required<AiReadingResponse> {
  if (!response.title || !response.translation || !Array.isArray(response.segments) || !Array.isArray(response.targets)) {
    throw new Error('AI 返回的文章结构不完整')
  }
  const expected = new Set(wordIds)
  const visibleText = [response.title, response.translation, ...response.segments.map((segment) => segment.text)].join(' ')
  if (/[0-9a-f]{8}-[0-9a-f-]{27,}/i.test(visibleText)) throw new Error('AI 文章包含了内部标识符，请重新生成')
  const segmentIds = new Set(response.segments.map((segment) => segment.wordId).filter(Boolean))
  const targetIds = new Set(response.targets.map((target) => target.wordId))
  for (const wordId of expected) {
    if (!segmentIds.has(wordId) || !targetIds.has(wordId)) throw new Error('AI 文章未覆盖全部目标词')
  }
  for (const target of response.targets) {
    if (!expected.has(target.wordId) || !isUsableHeadword(target.headword) || !hasDistinctChoices(target)) {
      throw new Error('AI 测义选项不符合要求')
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

function hasDistinctChoices(target: ReadingTarget): boolean {
  if (!Array.isArray(target.choices) || target.choices.length !== 3) return false
  const normalizedChoices = target.choices.map(normalizeChoice)
  const correct = normalizeChoice(target.contextualMeaning)
  const distractors = normalizedChoices.filter((choice) => choice !== correct)
  return new Set(normalizedChoices).size === 3
    && normalizedChoices.includes(correct)
    && distractors.length === 2
    && !distractors.some((choice) => meaningsTooSimilar(choice, correct))
}

async function repairTargetChoices(
  settings: AppSettings,
  targets: ReadingTarget[],
  signal?: AbortSignal,
): Promise<Map<string, Pick<ReadingTarget, 'choices' | 'explanation'>>> {
  if (!targets.length) return new Map()
  const controller = new AbortController()
  signal?.addEventListener('abort', () => controller.abort(), { once: true })
  const timer = window.setTimeout(() => controller.abort(), 20_000)
  try {
    const response = await fetch(settings.deepseekBaseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.deepseekApiKey.trim()}` },
      body: JSON.stringify({
        model: settings.deepseekModel,
        stream: false,
        response_format: { type: 'json_object' },
        temperature: 0.4,
        messages: [{ role: 'user', content: `Repair only the multiple-choice options for these vocabulary targets: ${JSON.stringify(targets)}. Return JSON {"targets":[{"wordId":"...","choices":["three concise Simplified Chinese choices including the exact contextualMeaning"],"explanation":"..."}]}. Distractors must have the same part of speech but clearly different meanings. Do not use synonyms, paraphrases, shared two-character meaning stems, or degree-only differences.` }],
      }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error('AI 选项修复失败')
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
    const content = payload.choices?.[0]?.message?.content
    if (!content) throw new Error('AI 选项修复返回为空')
    const parsed = JSON.parse(content) as { targets?: Array<{ wordId: string; choices: string[]; explanation?: string }> }
    return new Map((parsed.targets ?? []).map((target) => [target.wordId, { choices: target.choices, explanation: target.explanation ?? '' }]))
  } finally {
    window.clearTimeout(timer)
  }
}

function buildPrompt(
  rows: Array<{ wordId: string; headword: string; senses: string[] }>,
  level: AppSettings['articleLevel'],
  topic: string,
): string {
  return `Create one coherent English reading passage at CEFR ${level} level${topic ? ` about ${topic}` : ''}.
Use every target naturally and do not omit any. Stream newline-delimited JSON (NDJSON). Output one complete JSON object per line and no markdown.
Targets: ${JSON.stringify(rows)}
The target event headword must exactly copy the matching Targets.headword. Never display or use wordId as an English word.
Lines in this exact order:
{"type":"meta","title":"string","level":"${level}","targetWordIds":["ids"]}
{"type":"paragraph","text":"one paragraph"} (one or more lines)
{"type":"target","wordId":"string","headword":"string","contextualMeaning":"concise Simplified Chinese meaning","choices":["exactly three distinct Simplified Chinese choices including contextualMeaning"],"explanation":"concise Simplified Chinese explanation"} (one per target)
{"type":"translation","text":"complete Simplified Chinese translation"}
{"type":"done"}
For each target, make the two distractors plausible and the same part of speech, but from clearly different semantic categories. Never use synonyms, near-synonyms, paraphrases, degree-only differences, or options that differ by just one modifier. Keep all three choices short and easy to distinguish.
Avoid factual claims that require current information.`
}

type StreamProgress = { title?: string; paragraphs: string[]; targetCount: number }

function buildSegments(paragraphs: string[], targets: ReadingTarget[]): ReadingSegment[] {
  const targetByWord = [...targets].sort((a, b) => b.headword.length - a.headword.length)
  const pattern = targetByWord.map((target) => target.headword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  if (!pattern) return [{ text: paragraphs.join('\n\n') }]
  const regex = new RegExp(`\\b(${pattern})\\b`, 'gi')
  return paragraphs.flatMap((paragraph, paragraphIndex) => {
    const segments: ReadingSegment[] = []
    let cursor = 0
    for (const match of paragraph.matchAll(regex)) {
      const index = match.index ?? 0
      if (index > cursor) segments.push({ text: paragraph.slice(cursor, index) })
      const target = targetByWord.find((row) => row.headword.toLowerCase() === match[0].toLowerCase())
      segments.push({ text: match[0], wordId: target?.wordId })
      cursor = index + match[0].length
    }
    segments.push({ text: `${paragraph.slice(cursor)}${paragraphIndex < paragraphs.length - 1 ? '\n\n' : ''}` })
    return segments
  })
}

async function requestArticle(
  settings: AppSettings,
  prompt: string,
  onProgress?: (progress: StreamProgress) => void,
  externalSignal?: AbortSignal,
): Promise<AiReadingResponse> {
  if (!settings.deepseekApiKey.trim()) throw new Error('请先在设置页填写 DeepSeek API Key')
  const controller = new AbortController()
  externalSignal?.addEventListener('abort', () => controller.abort(), { once: true })
  let timeoutMessage = ''
  let receivedFirst = false
  let stallTimer = 0
  const resetStall = () => {
    window.clearTimeout(stallTimer)
    stallTimer = window.setTimeout(() => { timeoutMessage = receivedFirst ? '文章流已中断 20 秒，请重试' : '20 秒内未收到文章片段，请重试'; controller.abort() }, 20_000)
  }
  const totalTimer = window.setTimeout(() => { timeoutMessage = '文章生成超过 120 秒，已自动停止'; controller.abort() }, 120_000)
  resetStall()
  const response = await fetch(settings.deepseekBaseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.deepseekApiKey.trim()}` },
    body: JSON.stringify({
      model: settings.deepseekModel,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      temperature: 0.6,
    }),
    signal: controller.signal,
  })
  if (!response.ok) {
    window.clearTimeout(stallTimer); window.clearTimeout(totalTimer)
    const messages: Record<number, string> = { 401: 'DeepSeek Key 无效，请到设置中更新', 402: 'DeepSeek 余额不足，请充值后重试', 429: '请求过多，请稍后重试' }
    throw new Error(messages[response.status] ?? (response.status >= 500 ? 'DeepSeek 服务暂时不可用，请稍后重试' : `文章生成失败（HTTP ${response.status}）`))
  }
  if (!response.body) throw new Error('浏览器无法读取流式响应')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let sseBuffer = ''
  let ndjsonBuffer = ''
  let title = ''
  const paragraphs: string[] = []
  const targets: ReadingTarget[] = []
  let translation = ''
  const consumeEvent = (line: string) => {
    if (!line.trim()) return
    const event = JSON.parse(line) as Record<string, unknown>
    if (event.type === 'meta') title = String(event.title ?? '')
    if (event.type === 'paragraph') paragraphs.push(String(event.text ?? ''))
    if (event.type === 'target') targets.push(event as unknown as ReadingTarget)
    if (event.type === 'translation') translation = String(event.text ?? '')
    onProgress?.({ title, paragraphs: [...paragraphs], targetCount: targets.length })
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      receivedFirst = true
      resetStall()
      sseBuffer += decoder.decode(value, { stream: true })
      const lines = sseBuffer.split(/\r?\n/)
      sseBuffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        const payload = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }
        ndjsonBuffer += payload.choices?.[0]?.delta?.content ?? ''
        const eventLines = ndjsonBuffer.split(/\r?\n/)
        ndjsonBuffer = eventLines.pop() ?? ''
        for (const eventLine of eventLines) consumeEvent(eventLine)
      }
    }
    if (ndjsonBuffer.trim()) consumeEvent(ndjsonBuffer)
  } catch (error) {
    if (timeoutMessage) throw new Error(timeoutMessage)
    if (externalSignal?.aborted) throw new Error('已取消文章生成')
    throw error
  } finally {
    window.clearTimeout(stallTimer); window.clearTimeout(totalTimer)
  }
  return { title, segments: buildSegments(paragraphs, targets), targets, translation }
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
  if ((existing?.status === 'ready' || existing?.status === 'completed') && !options.force && cachedSessionHasValidTargets(existing)) return existing
  const settings = await loadSettings()
  const level = options.level ?? settings.articleLevel
  await repairVocabularyIntegrity(options.wordIds)
  const words = await db.wordbook.bulkGet(options.wordIds)
  const entries = await db.dictionaryEntries.bulkGet(words.map((word) => word?.entryId ?? ''))
  const promptRows: Array<{ wordId: string; headword: string; senses: string[] }> = []
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
    promptRows.push({ wordId, headword: entry.headword, senses: parseJsonArray(entry.sensesJson).slice(0, 4) })
  }
  const validWordIds = promptRows.map((row) => row.wordId)
  const now = new Date().toISOString()
  let session: ReadingSession = {
    sessionId,
    dayKey: options.dayKey,
    batchIndex: options.batchIndex,
    selectionSeed: options.seed,
    level,
    topic: options.topic?.trim() ?? '',
    targetWordIds: validWordIds,
    status: 'streaming',
    segmentsJson: '[]',
    targetsJson: '[]',
    translation: '',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  await db.readingSessions.put(session)
  await markPayloadChanged('readingSessions', session, session.updatedAt)
  try {
    if (!validWordIds.length) throw new Error('今天的目标词资料不完整，请重新查词或安装词典后重试')
    let generated: AiReadingResponse | undefined
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        generated = await requestArticle(settings, buildPrompt(promptRows, level, session.topic), options.onProgress, options.signal)
        const expectedHeadwords = new Map(promptRows.map((row) => [row.wordId, row.headword]))
        generated.targets = generated.targets?.map((target) => ({
          ...target,
          headword: expectedHeadwords.get(target.wordId) ?? target.headword,
          choices: [...target.choices].sort((left, right) => hash(`${sessionId}:${target.wordId}:${left}`) - hash(`${sessionId}:${target.wordId}:${right}`)),
        }))
        const invalidTargets = generated.targets?.filter((target) => !hasDistinctChoices(target)) ?? []
        if (invalidTargets.length) {
          const repairedChoices = await repairTargetChoices(settings, invalidTargets, options.signal)
          generated.targets = generated.targets?.map((target) => {
            const repair = repairedChoices.get(target.wordId)
            if (!repair) return target
            return {
              ...target,
              choices: [...repair.choices].sort((left, right) => hash(`${sessionId}:${target.wordId}:${left}`) - hash(`${sessionId}:${target.wordId}:${right}`)),
              explanation: repair.explanation || target.explanation,
            }
          })
        }
        validateResponse(generated, validWordIds)
        break
      } catch (error) {
        lastError = error
        if (options.signal?.aborted) break
      }
    }
    if (!generated) throw lastError
    validateResponse(generated, validWordIds)
    session = {
      ...session,
      status: 'ready',
      title: generated.title,
      segmentsJson: JSON.stringify(generated.segments),
      targetsJson: JSON.stringify(generated.targets),
      translation: generated.translation,
      error: undefined,
      updatedAt: new Date().toISOString(),
    }
  } catch (error) {
    session = { ...session, status: 'failed', error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() }
  }
  await db.readingSessions.put(session)
  await markPayloadChanged('readingSessions', session, session.updatedAt)
  return session
}

export function generateReadingSession(options: {
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
  if (active && !options.force) return active
  const task = generateReadingSessionImpl(options).finally(() => activeGenerations.delete(sessionId))
  activeGenerations.set(sessionId, task)
  return task
}

export async function preGenerateDailyArticle(dayKey: string): Promise<ReadingSession | undefined> {
  const settings = await loadSettings()
  if (!settings.deepseekApiKey.trim()) return undefined
  const firstBatch = (await buildReadingTargetBatches(dayKey))[0]
  if (!firstBatch?.length) return undefined
  return generateReadingSession({ dayKey, batchIndex: 0, seed: 0, wordIds: firstBatch, level: settings.articleLevel })
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
