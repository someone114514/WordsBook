import type { AppSettings, DictionaryEntry, SenseRecord } from '../../types/models'

function parseArray(raw: string | undefined): unknown[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value.replace(/\\r\\n|\\n|\\r/g, '\n').trim()
  if (!value || typeof value !== 'object') return ''
  const row = value as Record<string, unknown>
  for (const key of ['definition', 'meaning', 'gloss', 'text', 'translation', 'example']) {
    if (typeof row[key] === 'string' && row[key].trim()) {
      return row[key].replace(/\\r\\n|\\n|\\r/g, '\n').trim()
    }
  }
  return ''
}

function textLinesOf(value: unknown): string[] {
  return textOf(value)
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function looksEnglish(value: string): boolean {
  const latin = (value.match(/[A-Za-z]/g) ?? []).length
  const cjk = (value.match(/[\u3400-\u9fff]/g) ?? []).length
  return latin >= 4 && latin > cjk * 2
}

function looksChinese(value: string): boolean {
  return /[\u3400-\u9fff]/.test(value)
}

function parseStoredRecords(raw: string | undefined): SenseRecord[] {
  return parseArray(raw).flatMap((value, index) => {
    if (!value || typeof value !== 'object') return []
    const row = value as Partial<SenseRecord>
    const definitionEn = typeof row.definitionEn === 'string'
      ? row.definitionEn.replace(/\\r\\n|\\n|\\r/g, '\n').trim()
      : ''
    const glossZh = typeof row.glossZh === 'string'
      ? row.glossZh.replace(/\\r\\n|\\n|\\r/g, '\n').trim()
      : ''
    if (!definitionEn && !glossZh) return []
    return [{
      senseId: typeof row.senseId === 'string' && row.senseId ? row.senseId : `sense-${index + 1}`,
      pos: typeof row.pos === 'string' ? row.pos : undefined,
      definitionEn: definitionEn || undefined,
      glossZh: glossZh || undefined,
      examples: Array.isArray(row.examples)
        ? row.examples.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
        : [],
    }]
  })
}

/**
 * Reads the v2 bilingual sense contract and safely derives a best-effort view
 * from legacy dictionaries. Ambiguous legacy rows are never claimed as paired.
 */
export function parseSenseRecords(entry: DictionaryEntry): SenseRecord[] {
  const stored = parseStoredRecords(entry.senseRecordsJson)
  if (stored.length) return stored

  const senses = parseArray(entry.sensesJson).flatMap(textLinesOf)
  const usage = parseArray(entry.usageJson).flatMap(textLinesOf)
  const examples = parseArray(entry.examplesJson).flatMap(textLinesOf)
  const english = usage.filter(looksEnglish)
  const splitSenses = senses.map((sense) => {
    const parts = sense.split(/[；;]/).map((part) => part.trim()).filter(Boolean)
    const definitionEn = parts.find(looksEnglish)
    const glossZh = parts.filter((part) => part !== definitionEn).join('；') || undefined
    const posMatch = sense.match(/^([A-Za-z.]+)\s*[:：]/)
    return {
      definitionEn,
      glossZh: glossZh && looksChinese(glossZh) ? glossZh.replace(/^[A-Za-z.]+\s*[:：]\s*/, '') : undefined,
      pos: posMatch?.[1],
    }
  })
  const count = Math.max(senses.length, english.length, 1)
  return Array.from({ length: count }, (_, index) => {
    const legacySense = senses[index] ?? ''
    const split = splitSenses[index]
    return {
      senseId: `${entry.entryId}:legacy:${index + 1}`,
      pos: split?.pos ?? entry.posList[index] ?? entry.posList[0],
      definitionEn: split?.definitionEn ?? english[index] ?? (looksEnglish(legacySense) ? legacySense : undefined),
      glossZh: split?.glossZh ?? (looksChinese(legacySense) ? legacySense : undefined),
      examples: examples[index] ? [examples[index]!] : [],
    }
  }).filter((record) => record.definitionEn || record.glossZh || record.examples.length)
}

export interface DefinitionLine {
  senseId: string
  pos?: string
  primary: string
  secondary?: string
}

export function definitionLines(
  entry: DictionaryEntry,
  level: AppSettings['articleLevel'],
  language: AppSettings['definitionLanguage'],
): DefinitionLine[] {
  const englishFirst = language === 'english-first'
    || (language === 'adaptive' && (level === 'B2' || level === 'C1'))
  return parseSenseRecords(entry).flatMap((record) => {
    const primary = englishFirst
      ? record.definitionEn ?? record.glossZh
      : record.glossZh ?? record.definitionEn
    if (!primary) return []
    const secondary = englishFirst
      ? record.glossZh
      : record.definitionEn
    return [{
      senseId: record.senseId,
      pos: record.pos,
      primary,
      secondary: secondary && secondary !== primary ? secondary : undefined,
    }]
  })
}
