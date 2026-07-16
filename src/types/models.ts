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
  /** Stable vocabulary identity. Dictionary package entry ids may change between installs. */
  headword?: string
  headwordLower?: string
  entrySnapshot?: Pick<DictionaryEntry, 'headword' | 'headwordLower' | 'phonetic' | 'posList' | 'sensesJson' | 'examplesJson' | 'usageJson' | 'audioKey'>
  integrityStatus?: 'ready' | 'needs-repair'
  addedAt: string
  note: string
  tags: string[]
  archived: 0 | 1
}

export interface StudyList {
  listId: string
  name: string
  description: string
  studyEnabled: 0 | 1
  systemType?: 'lookup' | 'legacy' | 'default'
  createdAt: string
  updatedAt: string
}

export interface StudyListItem {
  membershipId: string
  listId: string
  wordId: string
  source?: 'lookup' | 'article' | 'manual' | 'import' | 'migration'
  /** Membership and learning activation are intentionally separate. */
  learningEnabled?: 0 | 1
  /** Backlog words may be auto-promoted to fill a future daily-new quota. */
  autoActivate?: 0 | 1
  addedAt: string
}

export interface ReviewState {
  wordId: string
  cycle: number
  lastReviewedAt?: string
  nextReviewAt: string
  successCount: number
  lapseCount: number
  totalReviews: number
  fsrsState?: 0 | 1 | 2 | 3
  stability?: number
  difficulty?: number
  elapsedDays?: number
  scheduledDays?: number
  learningSteps?: number
  reps?: number
  lapses?: number
  suspendedAt?: string
  sameDayRelearnAt?: string
  schedulerVersion?: 'fsrs-5'
}

export interface ReviewLog {
  id?: number
  wordId: string
  reviewedAt: string
  rating: 'remember' | 'forget' | 'again' | 'hard' | 'good' | 'easy'
  source?: 'flashcard' | 'context'
  wasNew?: boolean
  cycleBefore: number
  cycleAfter: number
  nextReviewAtBefore: string
  nextReviewAtAfter: string
  stateBefore?: number
  stateAfter?: number
  stabilityBefore?: number
  stabilityAfter?: number
  difficultyBefore?: number
  difficultyAfter?: number
  sessionAttemptCount?: number
  sessionRatings?: ReviewRating[]
  todayMasteryBefore?: number
  todayMasteryAfter?: number
}

export type ReviewRating = 'again' | 'hard' | 'good'
export type SchedulerRating = ReviewRating | 'easy'

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
  articleLevel: 'A2' | 'B1' | 'B2' | 'C1'
  syncDeepseekApiKey: boolean
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
  laterTodayCount?: number
  listIds?: string[]
  effectiveNewLimit?: number
  recoveryDays?: number
  daysSinceLastStudy?: number
  listContributions?: Array<{ listId: string; name: string; count: number }>
}

export type DailyQueueKind = 'card' | 'article-read' | 'context-quiz' | 'summary'
export type DailyQueueReason =
  | 'initial'
  | 'new-repeat'
  | 'again-repeat'
  | 'hard-repeat'
  | 'context-retry'
  | 'reencounter'
  | 'list-change'
  | 'extra-batch'

export interface DailyLearningSession {
  sessionId: string
  dayKey: string
  status: 'active' | 'completed'
  phase: 'cards' | 'article' | 'summary'
  selectedListIds: string[]
  initialWordIds: string[]
  sourceRevision?: string
  sourceEligibleWordIds?: string[]
  dismissedSourceRevision?: string
  baseWordCount?: number
  extensionBatchCount?: number
  articleGenerationWordCount?: number
  /** Stable article batch plan for resuming reading after navigation or reload. */
  readingBatchesJson?: string
  activeReadingBatchIndex?: number
  cardsCompletedAt?: string
  articleStatus: 'waiting' | 'generating' | 'ready' | 'completed' | 'skipped' | 'failed' | 'stale'
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export interface DailyQueueItem {
  itemId: string
  sessionId: string
  kind: DailyQueueKind
  wordId?: string
  reason: DailyQueueReason
  position: number
  status: 'pending' | 'active' | 'completed' | 'skipped'
  attemptNo: number
  maxAttempts: number
  retrievability: number
  startingLongTermRetrievability?: number
  wasNew?: boolean
  todayMastery?: number
  /** Consecutive successful recalls within the current daily session. */
  recallStreak?: number
  /** Whether this word received Hard or Again during the current session. */
  weakSeen?: boolean
  attemptCount?: number
  nextGap?: number
  tomorrowPriority?: boolean
  createdAt: string
  updatedAt: string
}

export interface DailyQueueAttempt {
  attemptId: string
  sessionId: string
  itemId: string
  wordId: string
  rating: ReviewRating
  committedToFsrs: boolean
  masteryBefore?: number
  masteryAfter?: number
  reinsertionGap?: number
  effectiveFsrsRating?: ReviewRating
  answeredAt: string
}

export interface ReadingTarget {
  wordId: string
  headword: string
  contextualMeaning: string
  choices: string[]
  explanation: string
}

export type ReadingErrorCode =
  | 'missing-key'
  | 'auth'
  | 'quota'
  | 'rate-limit'
  | 'network'
  | 'timeout'
  | 'passage-invalid'
  | 'details-invalid'
  | 'cancelled'
  | 'unknown'

export interface ReadingSegment {
  text: string
  wordId?: string
}

export interface ReadingSession {
  sessionId: string
  dayKey: string
  batchIndex: number
  selectionSeed: number
  level: AppSettings['articleLevel']
  topic: string
  targetWordIds: string[]
  /** Words requested for this batch but omitted by the generated passage/details. */
  omittedTargetWordIds?: string[]
  /** Persisted counters make retries and successful generations reportable after sync. */
  generationAttemptCount?: number
  successfulGenerationCount?: number
  lastGeneratedAt?: string
  status: 'pending' | 'streaming' | 'enriching' | 'ready' | 'failed' | 'completed' | 'skipped'
  title?: string
  segmentsJson: string
  targetsJson: string
  translation: string
  error?: string
  errorCode?: ReadingErrorCode
  createdAt: string
  updatedAt: string
  streamedParagraphs?: number
  readerStage?: 0 | 1 | 2
  quizCursor?: number
  resultCursor?: number
  showTranslation?: boolean
  lastOpenedAt?: string
}

export interface ContextAttempt {
  attemptId: string
  sessionId: string
  wordId: string
  selectedMeaning?: string
  result: 'correct' | 'wrong' | 'uncertain'
  answeredAt: string
}

export interface LocalSecret {
  key: string
  value: string
  updatedAt?: string
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
  dictionaryEntries?: DictionaryEntry[]
  wordbook: WordbookItem[]
  reviewState: ReviewState[]
  reviewLogs: ReviewLog[]
  settings: SettingItem[]
  aiOverrides?: AiOverrideRecord[]
  aiOverrideHistory?: AiOverrideHistoryRecord[]
  studyLists?: StudyList[]
  studyListItems?: StudyListItem[]
  readingSessions?: ReadingSession[]
  contextAttempts?: ContextAttempt[]
  dailyLearningSessions?: DailyLearningSession[]
  dailyQueueItems?: DailyQueueItem[]
  dailyQueueAttempts?: DailyQueueAttempt[]
}

export interface ImportReport {
  importedDictionaryEntries: number
  importedWordbook: number
  importedReviewState: number
  importedReviewLogs: number
  importedSettings: number
  importedAiOverrides: number
  importedAiOverrideHistory: number
  importedStudyLists?: number
  importedStudyListItems?: number
  importedReadingSessions?: number
  importedContextAttempts?: number
}

export interface WordListImportReport {
  matched: number
  created: number
  pending: number
  duplicates: number
  invalid: number
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

export type SyncEntity =
  | 'dictionaryEntries'
  | 'wordbook'
  | 'reviewState'
  | 'reviewLogs'
  | 'settings'
  | 'aiOverrides'
  | 'aiOverrideHistory'
  | 'studyLists'
  | 'studyListItems'
  | 'readingSessions'
  | 'contextAttempts'
  | 'dailyLearningSessions'
  | 'dailyQueueItems'
  | 'dailyQueueAttempts'

export interface SyncMetaRecord {
  key: string
  value: unknown
}

export interface SyncRecordMeta {
  key: string
  entity: SyncEntity
  recordId: string
  updatedAt: string
  deletedAt?: string
  sourceClientId?: string
}

export interface SyncTombstone {
  key: string
  entity: SyncEntity
  recordId: string
  deletedAt: string
  sourceClientId?: string
}
