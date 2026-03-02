import { db } from '../../db/database'
import type {
  AiDictionaryEntryDraft,
  AiOverrideRecord,
  DictionaryEntry,
  DictionaryIndexRow,
} from '../../types/models'
import { buildPrefixTokens, normalizeWord } from './search'

const AI_PROMPT_VERSION = 'v1-detailed-bilingual'
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

function buildDictionaryPrompt(word: string): string {
  return `You are an expert bilingual lexicographer.
Generate a strict JSON object for the English word "${word}".
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
          content: buildDictionaryPrompt(word),
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

  return normalizeAiDraft(tryParseStructured(content), normalizeWord(word) || word)
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
}): Promise<AiDictionaryEntryDraft> {
  const normalized = normalizeWord(options.word)
  if (!normalized) {
    throw new Error('请输入有效单词')
  }

  if (!options.apiKey.trim()) {
    throw new Error('请先在设置页填写 Deepseek API Key')
  }

  return callDeepseek(normalized, options.apiKey.trim(), options.baseUrl.trim(), options.model.trim())
}

export async function applyAiOverrideToEntry(options: {
  entryId: string
  mode: 'add' | 'replace'
  draft: AiDictionaryEntryDraft
  model: string
}): Promise<AiOverrideRecord> {
  return db.transaction('rw', db.dictionaryEntries, db.aiOverrides, db.aiOverrideHistory, async () => {
    const entry = await db.dictionaryEntries.get(options.entryId)
    if (!entry) {
      throw new Error('词条不存在')
    }

    const existingOverride = await db.aiOverrides.get(options.entryId)
    await db.aiOverrideHistory.add({
      entryId: options.entryId,
      previousOverrideJson: existingOverride ? JSON.stringify(existingOverride) : '',
      createdAt: new Date().toISOString(),
    })

    const nextOverride = draftToOverride(options.entryId, options.mode, options.draft, options.model)
    await db.aiOverrides.put(nextOverride)
    return nextOverride
  })
}

export async function rollbackAiOverride(entryId: string): Promise<boolean> {
  return db.transaction('rw', db.aiOverrides, db.aiOverrideHistory, async () => {
    const existingOverride = await db.aiOverrides.get(entryId)
    if (!existingOverride) {
      return false
    }

    const latestHistory = await db.aiOverrideHistory.where('entryId').equals(entryId).reverse().first()
    if (!latestHistory) {
      await db.aiOverrides.delete(entryId)
      return true
    }

    if (!latestHistory.previousOverrideJson) {
      await db.aiOverrides.delete(entryId)
    } else {
      const previousOverride = JSON.parse(latestHistory.previousOverrideJson) as AiOverrideRecord
      await db.aiOverrides.put(previousOverride)
    }

    if (latestHistory.id !== undefined) {
      await db.aiOverrideHistory.delete(latestHistory.id)
    }

    return true
  })
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

  await db.transaction('rw', db.dictionaryEntries, db.dictionaryIndex, async () => {
    await db.dictionaryEntries.put(entry)
    await upsertEntryIntoIndex(entry.entryId, entry.headwordLower)
  })

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
