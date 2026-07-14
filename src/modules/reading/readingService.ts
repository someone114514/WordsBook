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
import { markPayloadChanged, markRecordDeleted } from '../sync/localSyncStore'
import { parseJsonArray } from '../../utils/json'
import { enqueueContextRetry } from '../review/dailyQueueService'
import { dictionaryEntryFromWordbook, isUsableVocabularyHeadword, repairVocabularyIntegrity } from '../wordbook/vocabularyIntegrity'

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
}

const activeGenerations = new Map<string, ActiveGeneration>()

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
    const targetIds = new Set(targets.map((target) => target.wordId))
    return !/[0-9a-f]{8}-[0-9a-f-]{27,}/i.test(visible)
      && targets.length > 0
      && targets.every((target) => isUsableHeadword(target.headword) && target.headword !== target.wordId)
      && (!expectedWordIds || (targetIds.size === expectedWordIds.length && expectedWordIds.every((wordId) => targetIds.has(wordId))))
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
        max_tokens: 1800,
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

function buildPassagePrompt(
  rows: Array<{ wordId: string; headword: string; senses: string[] }>,
  level: AppSettings['articleLevel'],
  topic: string,
): string {
  return `Write one coherent English reading passage at CEFR ${level}${topic ? ` about ${topic}` : ''}.
Use every target headword exactly as written and naturally in context: ${JSON.stringify(rows.map((row) => row.headword))}.
Return exactly one JSON object: {"article":"2-5 short English paragraphs"}. The article value must contain only the passage正文. Do not include a title, markdown, target IDs, vocabulary lists, explanations, translations, or notes. Avoid current-event claims.`
}

function buildDetailsPrompt(
  rows: Array<{ wordId: string; headword: string; senses: string[] }>,
  passage: string,
): string {
  return `Based only on this fixed English passage, create vocabulary questions and a Chinese translation.
PASSAGE:
${passage}
TARGETS:
${JSON.stringify(rows)}
Return one JSON object with this exact shape:
{"title":"concise English title","targets":[{"wordId":"copy exact target id","headword":"copy exact target headword","contextualMeaning":"concise Simplified Chinese meaning in this passage","choices":["exactly three distinct Simplified Chinese choices including contextualMeaning"],"explanation":"concise Simplified Chinese explanation"}],"translation":"complete Simplified Chinese translation"}
Return every target exactly once. Each distractor must have the same part of speech but a clearly different semantic category. Do not use synonyms, near-synonyms, paraphrases, shared two-character meaning stems, or degree-only differences.`
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

function extractStreamingArticle(rawJson: string): string {
  const field = /"article"\s*:\s*"/.exec(rawJson)
  if (!field) return ''
  let output = ''
  for (let index = field.index + field[0].length; index < rawJson.length; index += 1) {
    const char = rawJson[index]!
    if (char === '"') break
    if (char !== '\\') {
      output += char
      continue
    }
    const escaped = rawJson[index + 1]
    if (!escaped) break
    if (escaped === 'n') output += '\n'
    else if (escaped === 'r') output += '\r'
    else if (escaped === 't') output += '\t'
    else if (escaped === '"' || escaped === '\\' || escaped === '/') output += escaped
    else if (escaped === 'u') {
      const code = rawJson.slice(index + 2, index + 6)
      if (!/^[0-9a-f]{4}$/i.test(code)) break
      output += String.fromCharCode(Number.parseInt(code, 16))
      index += 4
    }
    index += 1
  }
  return output
}

function passageIncludesHeadword(passage: string, headword: string): boolean {
  const escaped = headword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  return new RegExp(`(^|[^A-Za-z])${escaped}(?=$|[^A-Za-z])`, 'i').test(passage)
}

function apiError(status: number): Error {
  const messages: Record<number, string> = { 401: 'DeepSeek Key 无效，请到设置中更新', 402: 'DeepSeek 余额不足，请充值后重试', 429: '请求过多，请稍后重试' }
  return new Error(messages[status] ?? (status >= 500 ? 'DeepSeek 服务暂时不可用，请稍后重试' : `文章生成失败（HTTP ${status}）`))
}

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

async function requestPassage(
  settings: AppSettings,
  prompt: string,
  onProgress?: (progress: StreamProgress) => void,
  externalSignal?: AbortSignal,
): Promise<string> {
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
      response_format: { type: 'json_object' },
      max_tokens: 2400,
      temperature: 0.5,
    }),
    signal: controller.signal,
  })
  if (!response.ok) { window.clearTimeout(stallTimer); window.clearTimeout(totalTimer); throw apiError(response.status) }
  if (!response.body) {
    window.clearTimeout(stallTimer)
    window.clearTimeout(totalTimer)
    throw new Error('浏览器无法读取流式响应')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let sseBuffer = ''
  let jsonBuffer = ''
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
        jsonBuffer += payload.choices?.[0]?.delta?.content ?? ''
        const passage = extractStreamingArticle(jsonBuffer)
        onProgress?.({ phase: 'article', rawText: passage, paragraphs: splitPassage(passage), targetCount: 0 })
      }
    }
  } catch (error) {
    if (timeoutMessage) throw new Error(timeoutMessage)
    if (externalSignal?.aborted) throw new Error('已取消文章生成')
    throw error
  } finally {
    window.clearTimeout(stallTimer); window.clearTimeout(totalTimer)
  }
  let passage = extractStreamingArticle(jsonBuffer)
  try {
    const parsed = JSON.parse(jsonBuffer) as { article?: string }
    passage = parsed.article ?? passage
  } catch {
    // The incremental decoder still provides a useful error/retry path for truncated JSON.
  }
  const normalized = splitPassage(passage).join('\n\n')
  if (!normalized) throw new Error('AI 没有返回文章正文，请重试')
  return normalized
}

async function requestDetails(
  settings: AppSettings,
  prompt: string,
  passage: string,
  onProgress?: (progress: StreamProgress) => void,
  externalSignal?: AbortSignal,
): Promise<Pick<Required<AiReadingResponse>, 'title' | 'targets' | 'translation'>> {
  const controller = new AbortController()
  externalSignal?.addEventListener('abort', () => controller.abort(), { once: true })
  const timer = window.setTimeout(() => controller.abort(), 60_000)
  onProgress?.({ phase: 'details', rawText: passage, paragraphs: splitPassage(passage), targetCount: 0 })
  try {
    const response = await fetch(settings.deepseekBaseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.deepseekApiKey.trim()}` },
      body: JSON.stringify({
        model: settings.deepseekModel,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        response_format: { type: 'json_object' },
        max_tokens: 4200,
        temperature: 0.35,
      }),
      signal: controller.signal,
    })
    if (!response.ok) throw apiError(response.status)
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
    const content = payload.choices?.[0]?.message?.content?.trim()
    if (!content) throw new Error('AI 没有返回题目与翻译')
    const json = content.replace(/^```json\s*/i, '').replace(/```\s*$/i, '')
    const parsed = JSON.parse(json) as { title?: string; targets?: ReadingTarget[]; translation?: string }
    if (!parsed.title || !Array.isArray(parsed.targets) || !parsed.translation
      || parsed.targets.some((target) => !target.wordId || !target.contextualMeaning || !Array.isArray(target.choices) || target.choices.length !== 3)) {
      throw new Error('题目与翻译结构不完整')
    }
    onProgress?.({ phase: 'details', rawText: passage, paragraphs: splitPassage(passage), targetCount: parsed.targets.length })
    return { title: parsed.title, targets: parsed.targets, translation: parsed.translation }
  } catch (error) {
    if (externalSignal?.aborted) throw new Error('已取消文章生成')
    if (controller.signal.aborted) throw new Error('题目与翻译生成超时，请重试')
    throw error
  } finally {
    window.clearTimeout(timer)
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
  if ((existing?.status === 'ready' || existing?.status === 'completed') && !options.force && cachedSessionHasValidTargets(existing, options.wordIds)) return existing
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
  const reusablePassage = options.force ? '' : cachedPassage(existing)
  let session: ReadingSession = {
    sessionId,
    dayKey: options.dayKey,
    batchIndex: options.batchIndex,
    selectionSeed: options.seed,
    level,
    topic: options.topic?.trim() ?? '',
    targetWordIds: validWordIds,
    status: reusablePassage ? 'enriching' : 'streaming',
    segmentsJson: reusablePassage ? JSON.stringify([{ text: reusablePassage }]) : '[]',
    targetsJson: '[]',
    translation: '',
    createdAt: existing?.createdAt ?? now,
    readerStage: existing?.readerStage ?? 0,
    showTranslation: existing?.showTranslation ?? false,
    updatedAt: now,
  }
  await db.readingSessions.put(session)
  await markPayloadChanged('readingSessions', session, session.updatedAt)
  try {
    if (!validWordIds.length) throw new Error('今天的目标词资料不完整，请重新查词或安装词典后重试')
    let passage = reusablePassage
    if (!passage) {
      let passageError: unknown
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const candidate = await requestPassage(settings, buildPassagePrompt(promptRows, level, session.topic), options.onProgress, options.signal)
          const missing = promptRows.filter((row) => !passageIncludesHeadword(candidate, row.headword))
          if (missing.length) throw new Error(`正文缺少目标词：${missing.map((row) => row.headword).join('、')}`)
          passage = candidate
          break
        } catch (error) {
          passageError = error
          if (options.signal?.aborted) break
        }
      }
      if (!passage) throw passageError
    }
    session = {
      ...session,
      status: 'enriching',
      segmentsJson: JSON.stringify([{ text: passage }]),
      streamedParagraphs: splitPassage(passage).length,
      error: undefined,
      updatedAt: new Date().toISOString(),
    }
    await db.readingSessions.put(session)
    await markPayloadChanged('readingSessions', session, session.updatedAt)
    options.onProgress?.({ phase: 'details', rawText: passage, paragraphs: splitPassage(passage), targetCount: 0 })

    let details: Awaited<ReturnType<typeof requestDetails>> | undefined
    let detailsError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        details = await requestDetails(settings, buildDetailsPrompt(promptRows, passage), passage, options.onProgress, options.signal)
        break
      } catch (error) {
        detailsError = error
        if (options.signal?.aborted) break
      }
    }
    if (!details) throw detailsError
    const generated: AiReadingResponse = {
      ...details,
      segments: buildSegments(splitPassage(passage), details.targets),
    }
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
  if (active && !options.force) {
    if (options.onProgress) {
      active.listeners.add(options.onProgress)
      if (active.lastProgress) options.onProgress(active.lastProgress)
    }
    if (!options.signal) return active.promise
    return new Promise<ReadingSession>((resolve, reject) => {
      const detach = () => {
        if (options.onProgress) active.listeners.delete(options.onProgress)
        options.signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = () => { detach(); reject(new Error('已取消文章生成')) }
      if (options.signal!.aborted) return onAbort()
      options.signal!.addEventListener('abort', onAbort, { once: true })
      active.promise.then((result) => { detach(); resolve(result) }, (error) => { detach(); reject(error) })
    })
  }
  const listeners = new Set<(progress: StreamProgress) => void>()
  if (options.onProgress) listeners.add(options.onProgress)
  const state = {} as ActiveGeneration
  const onProgress = (progress: StreamProgress) => {
    state.lastProgress = progress
    for (const listener of state.listeners) listener(progress)
  }
  const task = generateReadingSessionImpl({ ...options, onProgress }).finally(() => {
    if (activeGenerations.get(sessionId) === state) activeGenerations.delete(sessionId)
  })
  state.promise = task
  state.listeners = listeners
  activeGenerations.set(sessionId, state)
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

export async function saveReadingProgress(
  sessionId: string,
  readerStage: 0 | 1 | 2,
  showTranslation: boolean,
): Promise<void> {
  const session = await db.readingSessions.get(sessionId)
  if (!session) return
  const now = new Date().toISOString()
  const updated: ReadingSession = { ...session, readerStage, showTranslation, lastOpenedAt: now, updatedAt: now }
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
  return db.readingSessions.orderBy('updatedAt').reverse().toArray()
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
