import { normalizeWord } from '../dictionary/search'

type InflectionIndex = Record<string, string>

let loading: Promise<InflectionIndex> | undefined

/** Loads the optional, build-generated ECDICT surface-form index. */
export function loadArticleInflectionIndex(): Promise<InflectionIndex> {
  if (!loading) {
    if (import.meta.env.MODE === 'test') {
      loading = Promise.resolve({})
      return loading
    }
    const base = import.meta.env.BASE_URL || '/'
    loading = fetch(`${base}dictionaries/ecdict/lemma-index.json`)
      .then((response) => response.ok ? response.json() as Promise<InflectionIndex> : {})
      .catch(() => ({}))
  }
  return loading
}

export function canonicalArticleForm(value: string, index: InflectionIndex = {}): string {
  const normalized = normalizeWord(value)
  return (index[normalized] ?? normalized).split('|')[0] ?? normalized
}

export function articleLemmaCandidates(value: string, index: InflectionIndex = {}): string[] {
  const normalized = normalizeWord(value)
  return [...new Set((index[normalized] ?? normalized).split('|').filter(Boolean))]
}
