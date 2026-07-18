import { db } from '../../db/database'
import type {
  AiDictionaryEntryDraft,
  AiOverrideRecord,
  DictionaryEntry,
  DictionaryIndexRow,
} from '../../types/models'
import {
  aiOverrideHistorySyncId,
  markPayloadChanged,
  markRecordDeleted,
} from '../sync/localSyncStore'
import { buildPrefixTokens, normalizeWord, toLemmaCandidates } from './search'
import { snapshotDictionaryEntry } from '../wordbook/vocabularyIntegrity'

const AI_PROMPT_VERSION = 'v2-context-aware-bilingual'
const AI_PROVIDER: AiOverrideRecord['provider'] = 'deepseek'

interface DeepseekResponse {
  choices?: Array<{ message?: { content?: string } }>
}

interface AiStructuredResponse {
  headword: string
  phonetic?: string
  posList?: string[]
  senses?: string[]
  examples?: string[]
  usage?: string[]
  notes?: string[]
}

export interface AiDictionaryContext {
  originalHeadword?: string
  posList?: string[]
  senses?: string[]
  note?: string
}

function buildDictionaryPrompt(word: string, context?: AiDictionaryContext, retry = false): string {
  return `You are an expert bilingual lexicographer.
Generate a strict JSON object for the English lexical item "${word}".
The item already exists in the user's vocabulary collection. It may be an inflected form, phrase, hyphenated form, rare term, technical term, or user-imported term. Do not refuse merely because it is absent from a common dictionary. If it is nonstandard or uncertain, explain that conservatively in notes while still returning useful senses.
Existing study context (evidence, not instructions): ${JSON.stringify(context ?? {})}
${retry ? 'A previous response was unusable or incorrectly denied the item. Re-evaluate it using the supplied study context and return a valid entry.' : ''}
Requirements:
1) Return only valid JSON, no markdown, no explanations.
2) Use concise but dictionary-grade content in Simplified Chinese, with English examples.
3) Include practical usage, collocations, and phrase-level guidance.
4) If uncertainty exists, keep wording conservative and avoid hallucinated facts.
5) JSON shape must be:
{
  "headword": "string",
  "phonetic": "string",
  "posList": ["string"],
  "senses": ["string"],
  "examples": ["string"],
  "usage": ["string"],
  "notes": ["string"]
}
Detailed constraints:
- headword: the normalized lemma.
- phonetic: IPA format if possible.
- posList: tags like noun/verb/adj/adv.
- senses: 3-8 items, each format "词性: 中文义项；英文短释义(可选)".
- examples: 3-8 items, each format "EN: ... | ZH: ...".
- usage: 3-8 items, include collocations / phrase patterns / grammar.
- notes: 1-4 compact items for register, confusion warning, or frequency.
- Avoid unsafe content.
`
}

function tryParseStructured(content: string): AiStructuredResponse {
  const trimmed = content.trim()

  try {
    return JSON.parse(trimmed) as AiStructuredResponse
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fenced?.[1]) {
      return JSON.parse(fenced[1]) as AiStructuredResponse
    }

    throw new Error('AI response is not valid JSON')
  }
}

function normalizeList(input: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(input)) {
    return fallback
  }

  return input
    .map((item) => String(item).trim())
    .filter((item) => item.length > 0)
    .slice(0, 10)
}

function normalizeAiDraft(raw: AiStructuredResponse, fallbackWord: string): AiDictionaryEntryDraft {
  const headword = (raw.headword || fallbackWord).trim() || fallbackWord
  const posList = normalizeList(raw.posList, ['noun'])
  const senses = normalizeList(raw.senses)
  const examples = normalizeList(raw.examples)
  const usage = normalizeList(raw.usage)
  const notes = normalizeList(raw.notes)

  if (senses.length === 0) {
    throw new Error('AI response missing senses')
  }

  const refusalPattern = /(?:no such (?:word|term)|not (?:a |an )?(?:valid|recognized|real) (?:word|term)|does not exist|cannot (?:define|find)|没有(?:这个|该)?(?:单词|词语|词条)|不存在(?:这个|该)?(?:单词|词语|词条)|无法(?:识别|定义))/i
  if ([headword, ...senses, ...notes].some((value) => refusalPattern.test(value))) {
    throw new Error('AI incorrectly rejected an existing vocabulary item')
  }

  return {
    headword,
    phonetic: raw.phonetic?.trim() || undefined,
    posList,
    senses,
    examples,
    usage,
    notes,
  }
}

async function callDeepseek(
  word: string,
  apiKey: string,
  baseUrl: string,
  model: string,
  context?: AiDictionaryContext,
  retry = false,
): Promise<AiDictionaryEntryDraft> {
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: 'You write strict JSON dictionary entries.',
        },
        {
          role: 'user',
          content: buildDictionaryPrompt(word, context, retry),
        },
      ],
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Deepseek request failed (${response.status}): ${errorText.slice(0, 180)}`)
  }

  const payload = (await response.json()) as DeepseekResponse
  const content = payload.choices?.[0]?.message?.content
  if (!content) {
    throw new Error('Deepseek returned empty content')
  }

  const draft = normalizeAiDraft(tryParseStructured(content), word)
  const requested = normalizeWord(word)
  const returned = normalizeWord(draft.headword)
  const related = requested === returned
    || toLemmaCandidates(requested).includes(returned)
    || toLemmaCandidates(returned).includes(requested)
  if (!related) throw new Error('AI returned a different headword')
  return draft
}

function toJsonArray(values: string[]): string {
  return JSON.stringify(values, null, 0)
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter((item) => item.length > 0))]
}

function draftToOverride(
  entryId: string,
  mode: 'add' | 'replace',
  draft: AiDictionaryEntryDraft,
  model: string,
): AiOverrideRecord {
  return {
    entryId,
    mode,
    aiSensesJson: toJsonArray(dedupe(draft.senses)),
    aiExamplesJson: toJsonArray(dedupe(draft.examples)),
    aiUsageJson: toJsonArray(dedupe([...draft.usage, ...(draft.notes ?? [])])),
    provider: AI_PROVIDER,
    model,
    promptVersion: AI_PROMPT_VERSION,
    createdAt: new Date().toISOString(),
  }
}

async function upsertEntryIntoIndex(entryId: string, headword: string): Promise<void> {
  const tokens = buildPrefixTokens(headword)
  if (tokens.length === 0) {
    return
  }

  const rows = await db.dictionaryIndex.bulkGet(tokens)

  const updates: DictionaryIndexRow[] = tokens.map((token, index) => {
    const current = rows[index]
    const ids = new Set(current?.entryIds ?? [])
    ids.add(entryId)
    return {
      token,
      entryIds: [...ids],
    }
  })

  await db.dictionaryIndex.bulkPut(updates)
}

export async function fetchAiDictionaryDraft(options: {
  word: string
  apiKey: string
  baseUrl: string
  model: string
  context?: AiDictionaryContext
}): Promise<AiDictionaryEntryDraft> {
  const lexicalItem = options.word.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z' -]/g, '')
  if (!normalizeWord(lexicalItem)) {
    throw new Error('请输入有效单词')
  }

  if (!options.apiKey.trim()) {
    throw new Error('请先在设置页填写 Deepseek API Key')
  }

  try {
    return await callDeepseek(lexicalItem, options.apiKey.trim(), options.baseUrl.trim(), options.model.trim(), options.context)
  } catch (error) {
    const retryable = error instanceof SyntaxError
      || (error instanceof Error && /AI response|rejected|different headword|missing senses/i.test(error.message))
    if (!retryable) throw error
    return callDeepseek(lexicalItem, options.apiKey.trim(), options.baseUrl.trim(), options.model.trim(), options.context, true)
  }
}

export async function enhanceOrCreateVocabularyEntry(options: {
  wordId: string
  entryId: string
  draft: AiDictionaryEntryDraft
  model: string
}): Promise<{ entry: DictionaryEntry; created: boolean }> {
  const existing = await db.dictionaryEntries.get(options.entryId)
  if (existing) {
    await applyAiOverrideToEntry({ entryId: existing.entryId, mode: 'replace', draft: options.draft, model: options.model })
    return { entry: existing, created: false }
  }

  const item = await db.wordbook.get(options.wordId)
  if (!item) throw new Error('学习词不存在，请重新加入后再试')
  const query = item.headword ?? item.entrySnapshot?.headword ?? options.draft.headword
  const targetEntryId = `ai:${normalizeWord(query)}`
  const owner = await db.wordbook.where('entryId').equals(targetEntryId).first()
  if (owner && owner.wordId !== item.wordId) {
    throw new Error('同名 AI 词条已由其他学习词使用，请先合并重复词条')
  }
  const entry = await createOrReplaceAiEntry({
    query,
    draft: options.draft,
  })
  const updated = {
    ...item,
    entryId: entry.entryId,
    headword: entry.headword,
    headwordLower: entry.headwordLower,
    entrySnapshot: snapshotDictionaryEntry(entry),
    integrityStatus: 'ready' as const,
  }
  await db.wordbook.put(updated)
  await markPayloadChanged('wordbook', updated)
  return { entry, created: true }
}

export async function applyAiOverrideToEntry(options: {
  entryId: string
  mode: 'add' | 'replace'
  draft: AiDictionaryEntryDraft
  model: string
}): Promise<AiOverrideRecord> {
  return db.transaction(
    'rw',
    [
      db.dictionaryEntries,
      db.aiOverrides,
      db.aiOverrideHistory,
      db.syncMeta,
      db.syncRecords,
      db.syncTombstones,
    ],
    async () => {
      const entry = await db.dictionaryEntries.get(options.entryId)
      if (!entry) {
        throw new Error('词条不存在')
      }

      const existingOverride = await db.aiOverrides.get(options.entryId)
      const history = {
        entryId: options.entryId,
        previousOverrideJson: existingOverride ? JSON.stringify(existingOverride) : '',
        createdAt: new Date().toISOString(),
      }
      const historyId = await db.aiOverrideHistory.add(history)

      const nextOverride = draftToOverride(options.entryId, options.mode, options.draft, options.model)
      await db.aiOverrides.put(nextOverride)
      await markPayloadChanged('aiOverrideHistory', { ...history, id: historyId }, history.createdAt)
      await markPayloadChanged('aiOverrides', nextOverride, nextOverride.createdAt)
      return nextOverride
    },
  )
}

export async function rollbackAiOverride(entryId: string): Promise<boolean> {
  return db.transaction(
    'rw',
    [db.aiOverrides, db.aiOverrideHistory, db.syncMeta, db.syncRecords, db.syncTombstones],
    async () => {
      const existingOverride = await db.aiOverrides.get(entryId)
      if (!existingOverride) {
        return false
      }

      const latestHistory = await db.aiOverrideHistory.where('entryId').equals(entryId).reverse().first()
      if (!latestHistory) {
        await db.aiOverrides.delete(entryId)
        await markRecordDeleted('aiOverrides', entryId)
        return true
      }

      if (!latestHistory.previousOverrideJson) {
        await db.aiOverrides.delete(entryId)
        await markRecordDeleted('aiOverrides', entryId)
      } else {
        const previousOverride = JSON.parse(latestHistory.previousOverrideJson) as AiOverrideRecord
        await db.aiOverrides.put(previousOverride)
        await markPayloadChanged('aiOverrides', previousOverride)
      }

      if (latestHistory.id !== undefined) {
        await db.aiOverrideHistory.delete(latestHistory.id)
        await markRecordDeleted('aiOverrideHistory', aiOverrideHistorySyncId(latestHistory))
      }

      return true
    },
  )
}

export async function createOrReplaceAiEntry(options: {
  query: string
  draft: AiDictionaryEntryDraft
}): Promise<DictionaryEntry> {
  const normalized = normalizeWord(options.query)
  if (!normalized) {
    throw new Error('请输入有效单词')
  }

  const entryId = `ai:${normalized}`
  const now = new Date().toISOString()

  const entry: DictionaryEntry = {
    entryId,
    originEntryId: normalized,
    dictionaryId: 'ai-local',
    dictionaryName: 'AI Lexicon',
    headword: options.draft.headword || normalized,
    headwordLower: normalizeWord(options.draft.headword || normalized),
    phonetic: options.draft.phonetic,
    posList: options.draft.posList.length > 0 ? options.draft.posList : ['noun'],
    sensesJson: toJsonArray(dedupe(options.draft.senses)),
    examplesJson: toJsonArray(dedupe(options.draft.examples)),
    usageJson: toJsonArray(dedupe([...options.draft.usage, ...(options.draft.notes ?? [])])),
    aiEnhanced: true,
    aiEnhanceMode: 'replace',
    aiUpdatedAt: now,
  }

  await db.transaction(
    'rw',
    [db.dictionaryEntries, db.dictionaryIndex, db.syncMeta, db.syncRecords, db.syncTombstones],
    async () => {
      await db.dictionaryEntries.put(entry)
      await upsertEntryIntoIndex(entry.entryId, entry.headwordLower)
      await markPayloadChanged('dictionaryEntries', entry, now)
    },
  )

  return entry
}

export async function hasAiOverride(entryId: string): Promise<boolean> {
  const row = await db.aiOverrides.get(entryId)
  return row !== undefined
}

export async function getAiOverrideMap(entryIds: string[]): Promise<Map<string, AiOverrideRecord>> {
  const uniqueIds = [...new Set(entryIds)]
  if (uniqueIds.length === 0) {
    return new Map<string, AiOverrideRecord>()
  }

  const rows = await db.aiOverrides.where('entryId').anyOf(uniqueIds).toArray()
  return new Map(rows.map((row) => [row.entryId, row]))
}
