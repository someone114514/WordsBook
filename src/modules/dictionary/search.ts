import type { DictionaryEntry } from '../../types/models'

const LEMMA_RULES: Array<(word: string) => string | undefined> = [
  (word) => (word.endsWith('ies') && word.length > 4 ? `${word.slice(0, -3)}y` : undefined),
  (word) => {
    if (!word.endsWith('ing') || word.length <= 5) {
      return undefined
    }

    const base = word.slice(0, -3)
    const lastChar = base[base.length - 1]
    const previousChar = base[base.length - 2]
    if (base.length > 2 && lastChar === previousChar) {
      return base.slice(0, -1)
    }

    return base
  },
  (word) => (word.endsWith('ed') && word.length > 4 ? word.slice(0, -2) : undefined),
  (word) => (word.endsWith('es') && word.length > 4 ? word.slice(0, -2) : undefined),
  (word) => (word.endsWith('s') && word.length > 3 ? word.slice(0, -1) : undefined),
]

export function normalizeWord(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z'-]/g, '')
}

export function toLemmaCandidates(normalizedWord: string): string[] {
  const candidates = new Set<string>()

  for (const rule of LEMMA_RULES) {
    const value = rule(normalizedWord)
    if (value && value !== normalizedWord) {
      candidates.add(value)
    }
  }

  return [...candidates]
}

export function buildPrefixTokens(word: string, maxLength = 8): string[] {
  const normalized = normalizeWord(word)
  const tokens = new Set<string>()
  const upperBound = Math.min(normalized.length, maxLength)

  for (let index = 1; index <= upperBound; index += 1) {
    tokens.add(normalized.slice(0, index))
  }

  return [...tokens]
}

export function levenshteinDistance(source: string, target: string): number {
  if (source === target) {
    return 0
  }

  if (source.length === 0) {
    return target.length
  }

  if (target.length === 0) {
    return source.length
  }

  const matrix: number[][] = Array.from({ length: source.length + 1 }, () =>
    new Array<number>(target.length + 1).fill(0),
  )

  for (let row = 0; row <= source.length; row += 1) {
    matrix[row]![0] = row
  }

  for (let col = 0; col <= target.length; col += 1) {
    matrix[0]![col] = col
  }

  for (let row = 1; row <= source.length; row += 1) {
    for (let col = 1; col <= target.length; col += 1) {
      const cost = source[row - 1] === target[col - 1] ? 0 : 1
      matrix[row]![col] = Math.min(
        matrix[row - 1]![col]! + 1,
        matrix[row]![col - 1]! + 1,
        matrix[row - 1]![col - 1]! + cost,
      )
    }
  }

  return matrix[source.length]![target.length]!
}

export function dedupeEntries(entries: DictionaryEntry[]): DictionaryEntry[] {
  const seen = new Set<string>()

  return entries.filter((entry) => {
    if (seen.has(entry.entryId)) {
      return false
    }

    seen.add(entry.entryId)
    return true
  })
}
