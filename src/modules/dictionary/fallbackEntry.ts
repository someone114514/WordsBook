import type { DictionaryEntry } from '../../types/models'

function fallbackHeadword(entryId: string): string {
  const raw = entryId.startsWith('ai:') ? entryId.slice(3) : (entryId.split(':').pop() ?? entryId)
  return raw.replace(/[-_]+/g, ' ').trim() || entryId
}

export function buildFallbackDictionaryEntry(entryId: string): DictionaryEntry {
  const headword = fallbackHeadword(entryId)
  return {
    entryId,
    dictionaryId: 'missing-local-dictionary',
    dictionaryName: 'Missing local dictionary',
    headword,
    headwordLower: headword.toLowerCase(),
    phonetic: '',
    posList: [],
    sensesJson: '["Install or update the dictionary to show full definitions."]',
    examplesJson: '[]',
    usageJson: '[]',
    audioKey: '',
  }
}
