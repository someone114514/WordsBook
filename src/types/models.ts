export interface DictionaryMeta {
  id: 'active'
  version: string
  source: string
  checksum?: string
  installedAt: string
  locale: string
  entryCount: number
}

export interface DictionaryEntry {
  entryId: string
  originEntryId?: string
  dictionaryId?: string
  dictionaryName?: string
  aiEnhanced?: boolean
  aiEnhanceMode?: 'add' | 'replace'
  aiUpdatedAt?: string
  headword: string
  headwordLower: string
  phonetic?: string
  posList: string[]
  sensesJson: string
  examplesJson: string
  usageJson: string
  audioKey?: string
}

export interface DictionaryIndexRow {
  token: string
  entryIds: string[]
}

export interface WordbookItem {
  wordId: string
  entryId: string
  addedAt: string
  note: string
  tags: string[]
  archived: 0 | 1
}

export interface ReviewState {
  wordId: string
  cycle: number
  lastReviewedAt?: string
  nextReviewAt: string
  successCount: number
  lapseCount: number
  totalReviews: number
}

export interface ReviewLog {
  id?: number
  wordId: string
  reviewedAt: string
  rating: 'remember' | 'forget'
  cycleBefore: number
  cycleAfter: number
  nextReviewAtBefore: string
  nextReviewAtAfter: string
}

export interface SettingItem {
  key: string
  value: unknown
}

export interface AppSettings {
  autoPronunciation: boolean
  speechRate: number
  ttsEngine: 'auto' | 'browser' | 'youdao' | 'google' | 'dictionaryapi'
  dailyNewLimit: number
  dailyReviewLimit: number
  deepseekApiKey: string
  deepseekBaseUrl: string
  deepseekModel: string
}

export interface LookupResult {
  query: string
  normalized: string
  exactMatches: DictionaryEntry[]
  lemmaMatches: DictionaryEntry[]
  prefixMatches: DictionaryEntry[]
  fuzzyMatches: DictionaryEntry[]
  hasResult: boolean
}

export interface AddToWordbookResult {
  wordId: string
  alreadyExists: boolean
}

export interface StudyPlan {
  dueCount: number
  newCount: number
  queueWordIds: string[]
}

export interface ReviewCard {
  wordId: string
  entryId: string
  note: string
  tags: string[]
  entry: DictionaryEntry
  reviewState: ReviewState
}

export interface WordbookWithEntry {
  item: WordbookItem
  entry: DictionaryEntry
  reviewState: ReviewState | undefined
}

export interface BackupPayload {
  schemaVersion: number
  exportedAt: string
  wordbook: WordbookItem[]
  reviewState: ReviewState[]
  reviewLogs: ReviewLog[]
  settings: SettingItem[]
}

export interface ImportReport {
  importedWordbook: number
  importedReviewState: number
  importedReviewLogs: number
  importedSettings: number
}

export interface AiOverrideRecord {
  entryId: string
  mode: 'add' | 'replace'
  aiSensesJson: string
  aiExamplesJson: string
  aiUsageJson: string
  provider: 'deepseek'
  model: string
  promptVersion: string
  createdAt: string
}

export interface AiOverrideHistoryRecord {
  id?: number
  entryId: string
  previousOverrideJson: string
  createdAt: string
}

export interface AiDictionaryEntryDraft {
  headword: string
  phonetic?: string
  posList: string[]
  senses: string[]
  examples: string[]
  usage: string[]
  notes?: string[]
}
