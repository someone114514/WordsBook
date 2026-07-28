import { db } from '../../db/database'
import type { DictionaryEntry, WordbookItem } from '../../types/models'
import { normalizeWord } from '../dictionary/search'
import { markPayloadChanged } from '../sync/localSyncStore'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i

export function isUsableVocabularyHeadword(value: string | undefined): value is string {
  return Boolean(value && /[a-z]/i.test(value) && !UUID_PATTERN.test(value) && value.length <= 80)
}

export function deriveHeadwordFromEntryId(entryId: string): string | undefined {
  const candidates = entryId.split(':').reverse()
  return candidates.find((part) => /^[a-z][a-z' -]{0,79}$/i.test(part))
}

export function snapshotDictionaryEntry(entry: DictionaryEntry): NonNullable<WordbookItem['entrySnapshot']> {
  return {
    headword: entry.headword,
    headwordLower: normalizeWord(entry.headwordLower || entry.headword),
    phonetic: entry.phonetic,
    posList: [...entry.posList],
    sensesJson: entry.sensesJson,
    senseRecordsJson: entry.senseRecordsJson,
    examplesJson: entry.examplesJson,
    usageJson: entry.usageJson,
    audioKey: entry.audioKey,
  }
}

export function dictionaryEntryFromWordbook(item: WordbookItem): DictionaryEntry | undefined {
  const headword = item.headword ?? item.entrySnapshot?.headword ?? deriveHeadwordFromEntryId(item.entryId)
  if (!isUsableVocabularyHeadword(headword)) return undefined
  const snapshot = item.entrySnapshot
  return {
    entryId: item.entryId,
    dictionaryId: 'wordbook-snapshot',
    dictionaryName: '学习词快照',
    headword,
    headwordLower: item.headwordLower ?? snapshot?.headwordLower ?? normalizeWord(headword),
    phonetic: snapshot?.phonetic ?? '',
    posList: snapshot?.posList ?? [],
    sensesJson: snapshot?.sensesJson ?? '["释义待补全"]',
    senseRecordsJson: snapshot?.senseRecordsJson,
    examplesJson: snapshot?.examplesJson ?? '[]',
    usageJson: snapshot?.usageJson ?? '[]',
    audioKey: snapshot?.audioKey,
  }
}

export function unresolvedVocabularyEntry(item: WordbookItem): DictionaryEntry {
  return {
    entryId: item.entryId,
    dictionaryId: 'unresolved-wordbook-entry',
    dictionaryName: '待修复学习词',
    headword: '待修复词条',
    headwordLower: '',
    posList: [],
    sensesJson: '["原词典引用已失效，请重新查词或安装词典后修复"]',
    examplesJson: '[]',
    usageJson: '[]',
  }
}

export async function repairVocabularyIntegrity(wordIds?: string[]): Promise<{ repaired: number; unresolved: number }> {
  const words = wordIds?.length ? (await db.wordbook.bulkGet(wordIds)).filter((row): row is WordbookItem => Boolean(row)) : await db.wordbook.toArray()
  let repaired = 0
  let unresolved = 0
  for (const word of words) {
    let entry = await db.dictionaryEntries.get(word.entryId)
    const candidateHeadword = entry?.headword ?? word.headword ?? word.entrySnapshot?.headword ?? deriveHeadwordFromEntryId(word.entryId)
    if (!entry && isUsableVocabularyHeadword(candidateHeadword)) {
      entry = await db.dictionaryEntries.where('headwordLower').equals(normalizeWord(candidateHeadword)).first()
    }
    if (!entry && word.entrySnapshot && isUsableVocabularyHeadword(word.entrySnapshot.headword)) {
      entry = dictionaryEntryFromWordbook(word)
    }
    if (!entry && isUsableVocabularyHeadword(candidateHeadword)) {
      entry = dictionaryEntryFromWordbook({ ...word, headword: candidateHeadword })
    }
    if (!entry || !isUsableVocabularyHeadword(entry.headword)) {
      const next = { ...word, integrityStatus: 'needs-repair' as const }
      if (word.integrityStatus !== next.integrityStatus) {
        await db.wordbook.put(next)
        await markPayloadChanged('wordbook', next)
      }
      unresolved += 1
      continue
    }
    const existingOwner = entry.entryId !== word.entryId
      ? await db.wordbook.where('entryId').equals(entry.entryId).first()
      : undefined
    const next: WordbookItem = {
      ...word,
      entryId: existingOwner && existingOwner.wordId !== word.wordId ? word.entryId : entry.entryId,
      headword: entry.headword,
      headwordLower: normalizeWord(entry.headwordLower || entry.headword),
      entrySnapshot: snapshotDictionaryEntry(entry),
      integrityStatus: 'ready',
    }
    if (JSON.stringify(next) !== JSON.stringify(word)) {
      await db.wordbook.put(next)
      await markPayloadChanged('wordbook', next)
      repaired += 1
    }
  }
  return { repaired, unresolved }
}
