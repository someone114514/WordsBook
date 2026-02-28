import { db } from '../../db/database'
import type { DictionaryEntry, DictionaryMeta, LookupResult } from '../../types/models'
import { dedupeEntries, levenshteinDistance, normalizeWord, toLemmaCandidates } from './search'

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

export async function getInstalledDictionaryMeta(): Promise<DictionaryMeta | undefined> {
  return db.dictionaryMeta.get('active')
}

export async function lookupWord(query: string): Promise<LookupResult> {
  const normalized = normalizeWord(query)

  if (normalized.length === 0) {
    return buildEmptyResult(query)
  }

  const exactMatches = await db.dictionaryEntries.where('headwordLower').equals(normalized).toArray()

  const lemmaCandidates = toLemmaCandidates(normalized)
  const lemmaMatches: DictionaryEntry[] = []
  for (const lemma of lemmaCandidates) {
    const rows = await db.dictionaryEntries.where('headwordLower').equals(lemma).toArray()
    lemmaMatches.push(...rows)
  }

  const prefixRows = await db.dictionaryIndex.where('token').startsWith(normalized).limit(10).toArray()
  const prefixEntryIds = [...new Set(prefixRows.flatMap((row) => row.entryIds))]
  const prefixMatches = await getEntriesByIds(prefixEntryIds)

  const fuzzyMatches = await findFuzzyMatches(normalized)

  const exact = dedupeEntries(exactMatches)
  const lemma = dedupeEntries(lemmaMatches).filter(
    (entry) => !exact.some((exactEntry) => exactEntry.entryId === entry.entryId),
  )
  const prefix = dedupeEntries(prefixMatches).filter(
    (entry) =>
      !exact.some((exactEntry) => exactEntry.entryId === entry.entryId) &&
      !lemma.some((lemmaEntry) => lemmaEntry.entryId === entry.entryId),
  )
  const fuzzy = dedupeEntries(fuzzyMatches).filter(
    (entry) =>
      !exact.some((exactEntry) => exactEntry.entryId === entry.entryId) &&
      !lemma.some((lemmaEntry) => lemmaEntry.entryId === entry.entryId) &&
      !prefix.some((prefixEntry) => prefixEntry.entryId === entry.entryId),
  )

  return {
    query,
    normalized,
    exactMatches: exact,
    lemmaMatches: lemma,
    prefixMatches: prefix,
    fuzzyMatches: fuzzy,
    hasResult: exact.length + lemma.length + prefix.length + fuzzy.length > 0,
  }
}
