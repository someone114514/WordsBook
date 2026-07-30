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
  /** Structured bilingual senses. Older dictionary packages may omit this. */
  senseRecordsJson?: string
  examplesJson: string
  usageJson: string
  audioKey?: string
}

export interface SenseRecord {
  senseId: string
  pos?: string
  definitionEn?: string
  glossZh?: string
  examples: string[]
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
  entrySnapshot?: Pick<DictionaryEntry, 'headword' | 'headwordLower' | 'phonetic' | 'posList' | 'sensesJson' | 'senseRecordsJson' | 'examplesJson' | 'usageJson' | 'audioKey'>
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
  /** Per-skill evidence is deliberately separate from the FSRS memory state. */
  skillEvidenceJson?: string
  schedulerVersion?: 'fsrs-5'
}

export interface ReviewLog {
  id?: number
  wordId: string
  reviewedAt: string
  rating: 'remember' | 'forget' | 'again' | 'hard' | 'good' | 'easy'
  source?: 'flashcard' | 'context' | 'manual-relearn'
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

export type ReviewRating = 'again' | 'hard' | 'good' | 'easy'
export type SchedulerRating = ReviewRating

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
  roundWordCount: number
  articleEveryRounds: number
  practiceQuestionLimit: number
  deepseekApiKey: string
  deepseekBaseUrl: string
  deepseekModel: string
  articleLevel: 'A2' | 'B1' | 'B2' | 'C1'
  definitionLanguage: 'adaptive' | 'english-first' | 'chinese-first'
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
  /** All words currently eligible for today's queue before configured limits. */
  eligibleWordIds?: string[]
  laterTodayCount?: number
  listIds?: string[]
  effectiveNewLimit?: number
  recoveryDays?: number
  daysSinceLastStudy?: number
  recoveryMode?: boolean
  backlogDueCount?: number
  nextDueAt?: string
  listContributions?: Array<{ listId: string; name: string; count: number }>
}

export type DailyQueueKind = 'card' | 'article-read' | 'context-quiz' | 'summary'
export type LearningStage = 'probe' | 'read' | 'learn' | 'transfer' | 'retry'
export type LearningSkill = 'meaning-recall' | 'context-sense' | 'production' | 'spelling'
export type LearningEvidenceKind =
  | 'unprompted-card'
  | 'meaning-choice'
  | 'context-cloze'
  | 'manual-relearn'

export interface LearningUnit {
  unitId: string
  index: number
  wordIds: string[]
  dueWordIds: string[]
  newWordIds: string[]
  status: 'pending' | 'active' | 'completed'
  articleCompletedAt?: string
}

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
  status: 'active' | 'completed' | 'rolled-over'
  /** Legacy route phases remain readable while v2 uses learningStage for semantics. */
  phase: 'cards' | 'practice' | 'article' | 'summary' | 'probe' | 'read' | 'learn' | 'transfer' | 'retry'
  engineVersion?: 1 | 2
  sessionRevision?: number
  activityOrdinal?: number
  learningStage?: LearningStage
  activeUnitIndex?: number
  unitsJson?: string
  selectedListIds: string[]
  initialWordIds: string[]
  sourceRevision?: string
  sourceEligibleWordIds?: string[]
  dismissedSourceRevision?: string
  baseWordCount?: number
  extensionBatchCount?: number
  /** The active five-word learning round. Older sessions are upgraded lazily. */
  activeRoundIndex?: number
  /** Persisted round membership keeps in-progress cards stable while later rounds stay dynamic. */
  roundsJson?: string
  articleGenerationWordCount?: number
  /** Stable article batch plan for resuming reading after navigation or reload. */
  readingBatchesJson?: string
  /** Settings value used to build the persisted reading batches. */
  readingBatchRounds?: number
  activeReadingBatchIndex?: number
  /** The latest round already handed off to its scheduled article. */
  lastArticleRoundIndex?: number
  pendingPracticeRoundIndex?: number
  pendingPracticeSessionId?: string
  lastPracticeRoundIndex?: number
  cardsCompletedAt?: string
  articleStatus: 'waiting' | 'generating' | 'ready' | 'completed' | 'skipped' | 'failed' | 'stale'
  createdAt: string
  updatedAt: string
  completedAt?: string
  recoveryMode?: boolean
  recoveryBacklogCount?: number
  recoveryDays?: number
  recoveryCalibrationCount?: number
  recoveryCalibrationCorrect?: number
  recoveryAccuracy?: number
  recoveryNewWordsAdded?: boolean
  recoveryNewWordScale?: 0 | 0.5 | 1
}

export interface DailyQueueItem {
  itemId: string
  sessionId: string
  kind: DailyQueueKind
  wordId?: string
  reason: DailyQueueReason
  /** Identifies the frozen learning round that created this card. */
  roundIndex?: number
  unitId?: string
  stage?: LearningStage
  eligibleAfterOrdinal?: number
  notBeforeAt?: string
  canonicalGradeCommitted?: boolean
  memoryStatus?: 'pending' | 'retry-later' | 'passed' | 'tomorrow'
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
  /** After repeated failures, show instruction before the delayed micro-review. */
  coachingRequired?: boolean
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
  activityOrdinal?: number
  evidenceKind?: LearningEvidenceKind
  skill?: LearningSkill
  responseMs?: number
  hintLevel?: number
  answeredAt: string
}

export interface ReadingTarget {
  wordId: string
  headword: string
  /** The natural form that appeared in the generated passage, if it differs from the lemma. */
  surfaceForm?: string
  /** Exact source sense selected from the current study-card definitions. */
  sourceSense?: string
  contextualMeaning: string
  choices: string[]
  explanation: string
}

export type PracticeQuestionType = 'meaning-in-context' | 'usage-discrimination' | 'self-recall'

export interface PracticeQuestion {
  questionId: string
  type: PracticeQuestionType
  focusWordId: string
  headword: string
  /** Prompt strength selected by the learning engine, independent of answer correctness. */
  hintLevel?: 0 | 1 | 2
  /** Exact structured dictionary sense selected before generation. */
  sourceSense: string
  passage?: string
  stem: string
  options: string[]
  correctIndex: number
  evidence: string[]
  explanation: string
  distractorExplanations: string[]
  /** True only when all four explanations were verified to share option indexes before shuffling. */
  rationalesAligned?: boolean
}

export type ReadingErrorCode =
  | 'missing-key'
  | 'auth'
  | 'unauthorized'
  | 'quota'
  | 'rate-limit'
  | 'rate-limited'
  | 'server'
  | 'network'
  | 'timeout'
  | 'invalid-json'
  | 'contract-invalid'
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
  /** Article is the legacy/default value; round-practice stores a preloaded exercise bundle. */
  contentKind?: 'article' | 'round-practice'
  sourceWordIds?: string[]
  sourceWordSetHash?: string
  promptVersion?: string
  plannedQuestionCount?: number
  candidateWordIds?: string[]
  questionsJson?: string
  practiceSpecJson?: string
  skippedAt?: string
  targetWordIds: string[]
  /** Words requested for this batch but omitted by the generated passage/details. */
  omittedTargetWordIds?: string[]
  /** Words present in the passage whose generated quiz failed semantic validation. */
  unquizzedTargetWordIds?: string[]
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
  questionId?: string
  questionType?: PracticeQuestionType
  selectedOptionIndex?: number
  correctOptionIndex?: number
  roundIndex?: number
  result: 'correct' | 'wrong' | 'uncertain'
  responseMs?: number
  hintLevel?: number
  skill?: LearningSkill
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
