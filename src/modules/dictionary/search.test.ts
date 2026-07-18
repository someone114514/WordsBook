import { describe, expect, it } from 'vitest'
import { levenshteinDistance, normalizeWord, toLemmaCandidates } from './search'

describe('dictionary search helpers', () => {
  it('normalizes input word', () => {
    expect(normalizeWord('  Running!!! ')).toBe('running')
  })

  it('generates lemma candidates', () => {
    expect(toLemmaCandidates('studies')).toContain('study')
    expect(toLemmaCandidates('running')).toContain('run')
  })

  it('computes levenshtein distance', () => {
    expect(levenshteinDistance('word', 'work')).toBe(1)
    expect(levenshteinDistance('book', 'books')).toBe(1)
  })
})
