import { db } from '../../db/database'
import type { DictionaryEntry, DictionaryMeta, LookupResult } from '../../types/models'
import { dedupeEntries, levenshteinDistance, normalizeWord, toLemmaCandidates } from './search'
import { applyAiOverrides } from './entryOverrideMapper'
import { lookupRemoteDictionary } from './remoteDictionaryCache'

const DICTIONARY_PRIORITY = new Map<string, number>([
  ['ai-local', 0],
  ['common', 1],
  ['default', 2],
  ['ecdict-core', 3],
  ['ecdict-full', 3],
])

async function getEntriesByIds(entryIds: string[]): Promise<DictionaryEntry[]> {
  if (entryIds.length === 0) {
    return []
  }

  const rows = await db.dictionaryEntries.bulkGet(entryIds)
  return rows.filter((row): row is DictionaryEntry => row !== undefined)
}

function buildEmptyResult(query: string): LookupResult {
  return {
    query,
    normalized: normalizeWord(query),
    exactMatches: [],
    lemmaMatches: [],
    prefixMatches: [],
    fuzzyMatches: [],
    hasResult: false,
  }
}

async function findFuzzyMatches(normalized: string, maxCount = 5): Promise<DictionaryEntry[]> {
  if (normalized.length === 0) {
    return []
  }

  const seed = normalized.charAt(0)
  if (!seed) {
    return []
  }

  const candidates = await db.dictionaryEntries
    .where('headwordLower')
    .startsWith(seed)
    .limit(80)
    .toArray()

  return candidates
    .map((entry) => ({ entry, score: levenshteinDistance(normalized, entry.headwordLower) }))
    .filter((item) => item.score <= 2)
    .sort((left, right) => left.score - right.score)
    .slice(0, maxCount)
    .map((item) => item.entry)
}

function getDictionaryPriority(entry: DictionaryEntry): number {
  if (entry.entryId.startsWith('ai:')) {
    return 0
  }

  return DICTIONARY_PRIORITY.get(entry.dictionaryId ?? '') ?? 10
}

function rankEntries(entries: DictionaryEntry[]): DictionaryEntry[] {
  return [...entries].sort((left, right) => {
    const priorityDiff = getDictionaryPriority(left) - getDictionaryPriority(right)
    if (priorityDiff !== 0) {
      return priorityDiff
    }

    const lengthDiff = left.headword.length - right.headword.length
    if (lengthDiff !== 0) {
      return lengthDiff
    }

    return left.entryId.localeCompare(right.entryId)
  })
}

export async function getInstalledDictionaryMeta(): Promise<DictionaryMeta | undefined> {
  return db.dictionaryMeta.get('active')
}

export async function getDictionaryHealth(): Promise<{
  meta: DictionaryMeta | undefined
  entryCount: number
  indexCount: number
  healthy: boolean
}> {
  const [meta, entryCount, indexCount] = await Promise.all([
    db.dictionaryMeta.get('active'),
    db.dictionaryEntries.count(),
    db.dictionaryIndex.count(),
  ])

  const healthy = Boolean(meta) && entryCount > 0
  return { meta, entryCount, indexCount, healthy }
}

export async function lookupWord(query: string): Promise<LookupResult> {
  const normalized = normalizeWord(query)

  if (normalized.length === 0) {
    return buildEmptyResult(query)
  }

  const lemmaCandidates = toLemmaCandidates(normalized)
  const [exactMatches, lemmaMatches, prefixRows, prefixFromEntries, fuzzyMatches] = await Promise.all([
    db.dictionaryEntries.where('headwordLower').equals(normalized).toArray(),
    Promise.all(
      lemmaCandidates.map((lemma) => db.dictionaryEntries.where('headwordLower').equals(lemma).toArray()),
    ).then((rows) => rows.flat()),
    db.dictionaryIndex.where('token').startsWith(normalized).limit(10).toArray(),
    db.dictionaryEntries.where('headwordLower').startsWith(normalized).limit(24).toArray(),
    findFuzzyMatches(normalized),
  ])

  const prefixEntryIds = [...new Set(prefixRows.flatMap((row) => row.entryIds))]
  const prefixFromIndex = await getEntriesByIds(prefixEntryIds)
  const prefixMatches = dedupeEntries([...prefixFromIndex, ...prefixFromEntries])

  let remote = { exact: [] as DictionaryEntry[], lemma: [] as DictionaryEntry[], prefix: [] as DictionaryEntry[] }
  if (exactMatches.length + lemmaMatches.length === 0 && typeof window !== 'undefined' && 'caches' in window && navigator.onLine) {
    try { remote = await lookupRemoteDictionary(normalized) } catch { /* Core dictionary remains usable offline. */ }
  }
  const exact = rankEntries(dedupeEntries([...exactMatches, ...remote.exact]))
  const lemma = rankEntries(dedupeEntries([...lemmaMatches, ...remote.lemma])).filter(
    (entry) => !exact.some((exactEntry) => exactEntry.entryId === entry.entryId),
  )
  const prefix = rankEntries(dedupeEntries([...prefixMatches, ...remote.prefix])).filter(
    (entry) =>
      !exact.some((exactEntry) => exactEntry.entryId === entry.entryId) &&
      !lemma.some((lemmaEntry) => lemmaEntry.entryId === entry.entryId),
  )
  const fuzzy = rankEntries(dedupeEntries(fuzzyMatches)).filter(
    (entry) =>
      !exact.some((exactEntry) => exactEntry.entryId === entry.entryId) &&
      !lemma.some((lemmaEntry) => lemmaEntry.entryId === entry.entryId) &&
      !prefix.some((prefixEntry) => prefixEntry.entryId === entry.entryId),
  )

  const entriesWithAi = await applyAiOverrides(dedupeEntries([...exact, ...lemma, ...prefix, ...fuzzy]))
  const entryWithAiMap = new Map(entriesWithAi.map((entry) => [entry.entryId, entry]))
  const mapWithAi = (entries: DictionaryEntry[]) =>
    entries.map((entry) => entryWithAiMap.get(entry.entryId) ?? entry)

  const exactWithAi = mapWithAi(exact)
  const lemmaWithAi = mapWithAi(lemma)
  const prefixWithAi = mapWithAi(prefix)
  const fuzzyWithAi = mapWithAi(fuzzy)

  return {
    query,
    normalized,
    exactMatches: exactWithAi,
    lemmaMatches: lemmaWithAi,
    prefixMatches: prefixWithAi,
    fuzzyMatches: fuzzyWithAi,
    hasResult:
      exactWithAi.length + lemmaWithAi.length + prefixWithAi.length + fuzzyWithAi.length > 0,
  }
}
