import { db } from '../../db/database'
import type { DictionaryEntry, WordListImportReport } from '../../types/models'
import { buildPrefixTokens, toLemmaCandidates } from '../dictionary/search'
import { addWordToStudyList, ensureVocabularyItem } from './studyListService'
import { markPayloadChanged } from '../sync/localSyncStore'

interface ImportRow {
  word: string
  meaning: string
  note: string
  tags: string[]
}

function normalizeImportedTerm(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z'\-\s]/g, '').replace(/\s+/g, ' ')
}

function parseDelimitedLine(line: string, delimiter: string): string[] {
  const output: string[] = []
  let value = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"'
        index += 1
      } else quoted = !quoted
    } else if (char === delimiter && !quoted) {
      output.push(value.trim())
      value = ''
    } else value += char
  }
  output.push(value.trim())
  return output
}

export function parseWordListText(raw: string): ImportRow[] {
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (!lines.length) return []
  const delimiter = lines.some((line) => line.includes('\t')) ? '\t' : lines.some((line) => line.includes(',')) ? ',' : ''
  const first = delimiter ? parseDelimitedLine(lines[0]!, delimiter) : [lines[0]!]
  const lower = first.map((value) => value.toLowerCase())
  const hasHeader = lower.some((value) => ['word', '单词', 'meaning', '释义', 'note', '备注', 'tags', '标签'].includes(value))
  const indexes = {
    word: Math.max(0, lower.findIndex((value) => ['word', '单词'].includes(value))),
    meaning: lower.findIndex((value) => ['meaning', '释义'].includes(value)),
    note: lower.findIndex((value) => ['note', '备注'].includes(value)),
    tags: lower.findIndex((value) => ['tags', '标签'].includes(value)),
  }
  return lines.slice(hasHeader ? 1 : 0).map((line) => {
    const cells = delimiter ? parseDelimitedLine(line, delimiter) : [line]
    return {
      word: cells[indexes.word]?.trim() ?? '',
      meaning: indexes.meaning >= 0 ? cells[indexes.meaning]?.trim() ?? '' : cells[1]?.trim() ?? '',
      note: indexes.note >= 0 ? cells[indexes.note]?.trim() ?? '' : cells[2]?.trim() ?? '',
      tags: (indexes.tags >= 0 ? cells[indexes.tags] ?? '' : cells[3] ?? '')
        .split(/[;，,]/).map((tag) => tag.trim()).filter(Boolean),
    }
  })
}

export async function previewWordList(raw: string): Promise<{ rows: ImportRow[]; matched: number; pending: number; duplicates: number; invalid: number }> {
  const rows = parseWordListText(raw)
  let matched = 0; let pending = 0; let duplicates = 0; let invalid = 0
  const seen = new Set<string>()
  for (const row of rows) {
    const normalized = normalizeImportedTerm(row.word)
    if (!normalized) { invalid += 1; continue }
    if (seen.has(normalized)) { duplicates += 1; continue }
    seen.add(normalized)
    if (await findEntry(row.word)) matched += 1
    else if (!row.meaning) pending += 1
  }
  return { rows, matched, pending, duplicates, invalid }
}

async function findEntry(word: string): Promise<DictionaryEntry | undefined> {
  const normalized = normalizeImportedTerm(word)
  const exact = await db.dictionaryEntries.where('headwordLower').equals(normalized).first()
  if (exact) return exact
  if (normalized.includes(' ')) return undefined
  for (const lemma of toLemmaCandidates(normalized)) {
    const match = await db.dictionaryEntries.where('headwordLower').equals(lemma).first()
    if (match) return match
  }
  return undefined
}

async function createPendingEntry(row: ImportRow): Promise<DictionaryEntry> {
  const normalized = normalizeImportedTerm(row.word)
  const entry: DictionaryEntry = {
    entryId: `import:${normalized}`,
    dictionaryId: 'user-import',
    dictionaryName: row.meaning ? '导入词表' : '待补全',
    headword: row.word.trim(),
    headwordLower: normalized,
    posList: [],
    sensesJson: JSON.stringify(row.meaning ? [row.meaning] : []),
    examplesJson: '[]',
    usageJson: '[]',
  }
  await db.dictionaryEntries.put(entry)
  await markPayloadChanged('dictionaryEntries', entry, new Date().toISOString())
  const tokens = buildPrefixTokens(normalized)
  const existing = await db.dictionaryIndex.bulkGet(tokens)
  await db.dictionaryIndex.bulkPut(tokens.map((token, index) => ({
    token,
    entryIds: [...new Set([...(existing[index]?.entryIds ?? []), entry.entryId])],
  })))
  return entry
}

export async function importWordList(listId: string, raw: string): Promise<WordListImportReport> {
  const rows = parseWordListText(raw)
  const report: WordListImportReport = { matched: 0, created: 0, pending: 0, duplicates: 0, invalid: 0 }
  const seen = new Set<string>()
  for (const row of rows) {
    const normalized = normalizeImportedTerm(row.word)
    if (!normalized) { report.invalid += 1; continue }
    if (seen.has(normalized)) { report.duplicates += 1; continue }
    seen.add(normalized)
    let entry = await findEntry(row.word)
    if (entry) {
      report.matched += 1
      if (entry.dictionaryId === 'user-import' && row.meaning && entry.sensesJson === '[]') {
        entry = { ...entry, dictionaryName: '导入词表', sensesJson: JSON.stringify([row.meaning]) }
        await db.dictionaryEntries.put(entry)
        await markPayloadChanged('dictionaryEntries', entry)
      }
    }
    else {
      entry = await createPendingEntry(row)
      report.created += 1
      if (!row.meaning) report.pending += 1
    }
    const { item } = await ensureVocabularyItem(entry, row.note, row.tags)
    if (!(await addWordToStudyList(listId, item.wordId))) report.duplicates += 1
  }
  return report
}
