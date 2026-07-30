import dayjs from 'dayjs'
import { db } from '../../db/database'
import type {
  AppSettings,
  ContextAttempt,
  DailyLearningSession,
  DailyQueueAttempt,
  DailyQueueItem,
  DailyQueueReason,
  LearningEvidenceKind,
  LearningSkill,
  LearningUnit,
  ReviewRating,
  ReviewState,
} from '../../types/models'
import { markPayloadChanged, markRecordChanged } from '../sync/localSyncStore'
import {
  buildAdditionalStudyWordIds,
  buildTodayPlan,
  listEligibleStudyWordIds,
  persistPreparedCardGrade,
  prepareCardGrade,
} from './reviewService'
import { getReviewRetrievability } from './scheduler'
import { getStudyQueueRevision } from './studyDataRevision'
import { repairVocabularyIntegrity } from '../wordbook/vocabularyIntegrity'
import { loadSettings } from '../settings/settingsService'
import { findReadingBatchForUnit, parseReadingBatchesJson } from '../reading/readingBatchPlan'

const MAX_DAILY_ATTEMPTS = 3
const AGAIN_MIN_ACTIVITY_GAP = 3
const HARD_MIN_ACTIVITY_GAP = 5
const AGAIN_DELAY_MS = 60_000
const HARD_DELAY_MS = 180_000
const MICRO_REVIEW_DELAY_MS = 15 * 60_000
const ENGINE_VERSION = 2 as const
export const DEFAULT_DAILY_ROUND_SIZE = 10

type DailyRound = {
  index: number
  wordIds: string[]
  status: 'pending' | 'active' | 'completed'
  startedAt: string
  completedAt?: string
}

export interface DailyQueueSnapshot {
  session: DailyLearningSession
  items: DailyQueueItem[]
  attempts: DailyQueueAttempt[]
  current?: DailyQueueItem
  completedCards: number
  totalCards: number
  nextAvailableAt?: string
  waitingForActivities?: number
}

export interface DailyQueueChangePreview {
  revision: string
  eligibleWordIds: string[]
  addedWordIds: string[]
  removedWordIds: string[]
  dismissed: boolean
}

function dayKey(at = new Date()): string {
  return dayjs(at).format('YYYY-MM-DD')
}

export function initialTodayMastery(retrievability: number, isNew: boolean): number {
  if (isNew) return 0
  return Math.max(10, Math.min(95, Math.round(retrievability * 100)))
}

export function nextTodayMastery(current: number, rating: ReviewRating): number {
  return computeShortTermReview({ mastery: current }, rating).mastery
}

export function masteryReinsertionGap(mastery: number): number {
  if (mastery >= 100) return 0
  if (mastery >= 75) return 7
  if (mastery >= 50) return 5
  if (mastery >= 25) return 3
  return 2
}

export interface ShortTermReviewInput {
  mastery: number
  recallStreak?: number
  weakSeen?: boolean
  wasNew?: boolean
  startingLongTermRetrievability?: number
}

export interface ShortTermReviewOutcome {
  mastery: number
  recallStreak: number
  weakSeen: boolean
  passed: boolean
  reinsertionGap: number
  requiredRecallStreak: number
}

export function computeShortTermReview(
  input: ShortTermReviewInput,
  rating: ReviewRating,
): ShortTermReviewOutcome {
  const masteryBefore = Math.max(0, Math.min(100, Math.round(input.mastery)))
  const weakSeen = Boolean(input.weakSeen || rating === 'again' || rating === 'hard')
  const passed = rating === 'good' || rating === 'easy'
  const recallStreak = passed ? (input.recallStreak ?? 0) + 1 : 0
  const mastery = passed ? 100 : rating === 'hard' ? Math.max(25, Math.min(45, masteryBefore || 25)) : 0
  return {
    mastery,
    recallStreak,
    weakSeen,
    passed,
    reinsertionGap: passed ? 0 : rating === 'hard' ? HARD_MIN_ACTIVITY_GAP : AGAIN_MIN_ACTIVITY_GAP,
    requiredRecallStreak: 1,
  }
}

export function aggregateSessionRating(ratings: ReviewRating[]): ReviewRating {
  if (ratings.includes('again')) return 'again'
  if (ratings.includes('hard')) return 'hard'
  if (ratings.length > 0 && ratings.every((rating) => rating === 'easy')) return 'easy'
  return 'good'
}

function parseLearningUnits(raw: string | undefined): LearningUnit[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return []
    return value.filter((row): row is LearningUnit => Boolean(
      row
      && typeof row === 'object'
      && typeof (row as LearningUnit).unitId === 'string'
      && Number.isInteger((row as LearningUnit).index)
      && Array.isArray((row as LearningUnit).wordIds),
    ))
  } catch {
    return []
  }
}

function buildLearningUnits(
  sessionId: string,
  wordIds: string[],
  states: Array<ReviewState | undefined>,
  requestedSize: number,
): { units: LearningUnit[]; orderedWordIds: string[]; orderedStates: Array<ReviewState | undefined> } {
  const targetSize = Math.max(8, Math.min(12, Math.floor(requestedSize || DEFAULT_DAILY_ROUND_SIZE)))
  const rows = wordIds.map((wordId, index) => ({
    wordId,
    state: states[index],
    isNew: (states[index]?.reps ?? states[index]?.totalReviews ?? 0) === 0
      || Boolean(states[index]?.sameDayRelearnAt),
  }))
  const due = rows.filter((row) => !row.isNew)
  const fresh = rows.filter((row) => row.isNew)
  const units: LearningUnit[] = []
  const ordered: typeof rows = []
  while (due.length || fresh.length) {
    const selected = due.splice(0, Math.min(targetSize, due.length))
    const newSlots = Math.min(5, targetSize - selected.length, fresh.length)
    selected.push(...fresh.splice(0, newSlots))
    if (!selected.length) selected.push(...fresh.splice(0, Math.min(5, fresh.length)))
    const index = units.length
    const unitId = `${sessionId}:unit:${index + 1}`
    const dueWordIds = selected.filter((row) => !row.isNew).map((row) => row.wordId)
    const newWordIds = selected.filter((row) => row.isNew).map((row) => row.wordId)
    units.push({
      unitId,
      index,
      wordIds: selected.map((row) => row.wordId),
      dueWordIds,
      newWordIds,
      status: index === 0 ? 'active' : 'pending',
    })
    ordered.push(...selected)
  }
  return {
    units,
    orderedWordIds: ordered.map((row) => row.wordId),
    orderedStates: ordered.map((row) => row.state),
  }
}

function createInitialQueueItems(
  session: DailyLearningSession,
  wordIds: string[],
  states: Array<ReviewState | undefined>,
  at: Date,
  roundIndex = session.activeRoundIndex ?? 1,
): DailyQueueItem[] {
  const now = at.toISOString()
  const units = parseLearningUnits(session.unitsJson)
  const unitByWord = new Map(units.flatMap((unit) => unit.wordIds.map((wordId) => [wordId, unit] as const)))
  return wordIds.map((wordId, index) => {
    const state = states[index]
    const retrievability = state ? getReviewRetrievability(state, at) : 0
    const isNew = (state?.reps ?? state?.totalReviews ?? 0) === 0
    const unit = unitByWord.get(wordId)
    const isIntroduction = isNew || Boolean(unit?.newWordIds.includes(wordId))
    return {
      itemId: `${session.sessionId}:card:${index}`,
      sessionId: session.sessionId,
      kind: 'card',
      wordId,
      reason: 'initial',
      roundIndex: unit ? unit.index + 1 : roundIndex,
      unitId: unit?.unitId,
      stage: isIntroduction ? 'learn' : 'probe',
      eligibleAfterOrdinal: 0,
      notBeforeAt: now,
      canonicalGradeCommitted: false,
      memoryStatus: 'pending',
      position: index,
      status: 'pending',
      attemptNo: 1,
      maxAttempts: MAX_DAILY_ATTEMPTS,
      retrievability,
      startingLongTermRetrievability: retrievability,
      wasNew: isNew,
      todayMastery: initialTodayMastery(retrievability, isNew),
      recallStreak: 0,
      weakSeen: false,
      attemptCount: 0,
      nextGap: 0,
      tomorrowPriority: false,
      createdAt: now,
      updatedAt: now,
    }
  })
}

export async function previewDailyQueueChanges(sessionId: string, at = new Date()): Promise<DailyQueueChangePreview> {
  const session = await db.dailyLearningSessions.get(sessionId)
  if (!session) throw new Error('今日学习会话不存在')
  const revision = await getStudyQueueRevision()
  if (revision === (session.sourceRevision ?? revision)) {
    return { revision, eligibleWordIds: session.sourceEligibleWordIds ?? session.initialWordIds, addedWordIds: [], removedWordIds: [], dismissed: false }
  }
  const [eligibleWordIds, attempts, items, settings] = await Promise.all([
    listEligibleStudyWordIds([], session.selectedListIds.length ? session.selectedListIds : undefined, at),
    db.dailyQueueAttempts.where('sessionId').equals(sessionId).toArray(),
    db.dailyQueueItems.where('sessionId').equals(sessionId).toArray(),
    loadSettings(),
  ])
  const eligible = new Set(eligibleWordIds)
  const attempted = new Set(attempts.map((attempt) => attempt.wordId))
  const pendingWordIds = new Set(items.filter((item) => item.wordId && (item.status === 'pending' || item.status === 'active')).map((item) => item.wordId!))
  const latestPlan = await buildTodayPlan({
    at,
    listIds: session.selectedListIds.length ? session.selectedListIds : undefined,
    dailyNewLimit: settings.dailyNewLimit,
    dailyReviewLimit: settings.dailyReviewLimit,
    promoteImportBacklog: false,
  })
  const currentWords = new Set(session.initialWordIds)
  const addedWordIds = latestPlan.queueWordIds.filter((wordId) => !currentWords.has(wordId))
  return {
    revision,
    eligibleWordIds,
    addedWordIds,
    removedWordIds: session.initialWordIds.filter((wordId) => pendingWordIds.has(wordId) && !attempted.has(wordId) && !eligible.has(wordId)),
    dismissed: session.dismissedSourceRevision === revision,
  }
}

export async function dismissDailyQueueChanges(sessionId: string, revision: string): Promise<void> {
  const session = await db.dailyLearningSessions.get(sessionId)
  if (!session) return
  const updated = {
    ...session,
    dismissedSourceRevision: revision,
    sessionRevision: (session.sessionRevision ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  }
  await db.dailyLearningSessions.put(updated)
  await markPayloadChanged('dailyLearningSessions', updated, updated.updatedAt)
}

async function orderedItems(sessionId: string): Promise<DailyQueueItem[]> {
  return db.dailyQueueItems.where('sessionId').equals(sessionId).sortBy('position')
}

async function repairPersistedRounds(
  session: DailyLearningSession,
  at: Date,
): Promise<DailyLearningSession> {
  const [items, settings] = await Promise.all([orderedItems(session.sessionId), loadSettings()])
  const initialWords = [...new Set(items
    .filter((item) => item.kind === 'card' && item.wordId && item.reason === 'initial')
    .map((item) => item.wordId!))]
  const sourceWords = initialWords.length ? initialWords : session.initialWordIds
  const stored = parseRounds(session.roundsJson)
  const derived = stored.length ? stored : Array.from(
    { length: Math.ceil(sourceWords.length / settings.roundWordCount) },
    (_, index) => ({
      index: index + 1,
      wordIds: sourceWords.slice(index * settings.roundWordCount, index * settings.roundWordCount + settings.roundWordCount),
      status: 'pending' as const,
      startedAt: '',
    }),
  )
  const pendingRoundIndexes = items
    .filter((item) => item.kind === 'card' && (item.status === 'pending' || item.status === 'active'))
    .map((item) => item.roundIndex ?? 1)
  const activeRoundIndex = session.activeRoundIndex
    ?? (pendingRoundIndexes.length ? Math.min(...pendingRoundIndexes) : Math.max(1, derived.length))
  const normalized = derived.map((round) => ({
    ...round,
    status: round.index < activeRoundIndex ? 'completed' as const
      : round.index === activeRoundIndex ? 'active' as const : 'pending' as const,
    startedAt: round.index === activeRoundIndex ? (round.startedAt || at.toISOString()) : round.startedAt,
  }))
  const needsUpdate = session.activeRoundIndex !== activeRoundIndex
    || JSON.stringify(stored) !== JSON.stringify(normalized)
  if (!needsUpdate) return session
  const updated = {
    ...session,
    activeRoundIndex,
    roundsJson: JSON.stringify(normalized),
    sessionRevision: (session.sessionRevision ?? 0) + 1,
    updatedAt: at.toISOString(),
  }
  await db.dailyLearningSessions.put(updated)
  await markPayloadChanged('dailyLearningSessions', updated, updated.updatedAt)
  return updated
}

function parseRounds(raw: string | undefined): DailyRound[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return []
    return value.flatMap((round) => {
      if (!round || typeof round !== 'object') return []
      const row = round as Partial<DailyRound>
      const index = row.index
      if (typeof index !== 'number' || !Number.isInteger(index) || !Array.isArray(row.wordIds)) return []
      return [{
        index,
        wordIds: row.wordIds.filter((wordId): wordId is string => typeof wordId === 'string'),
        status: row.status === 'completed' || row.status === 'pending' ? row.status : 'active',
        startedAt: typeof row.startedAt === 'string' ? row.startedAt : '',
        completedAt: typeof row.completedAt === 'string' ? row.completedAt : undefined,
      }]
    })
  } catch { return [] }
}

function sameWordSet(left: string[] | undefined, right: string[] | undefined): boolean {
  if (!left || !right || left.length !== right.length) return false
  const expected = new Set(right)
  return left.every((wordId) => expected.has(wordId))
}

async function invalidateChangedFutureContent(
  session: DailyLearningSession,
  rounds: DailyRound[],
  settings: AppSettings,
  now: string,
): Promise<void> {
  const articleBatches: string[][] = []
  for (let index = 0; index < rounds.length; index += settings.articleEveryRounds) {
    const grouped = [...new Set(rounds.slice(index, index + settings.articleEveryRounds).flatMap((round) => round.wordIds))]
    for (let offset = 0; offset < grouped.length; offset += 12) articleBatches.push(grouped.slice(offset, offset + 12))
  }
  const records = await db.readingSessions.where('dayKey').equals(session.dayKey).toArray()
  const stale = records.filter((record) => {
    if (record.status === 'completed' || record.status === 'skipped') return false
    const expected = record.contentKind === 'round-practice'
      ? rounds.find((round) => round.index === record.batchIndex)?.wordIds
      : articleBatches[record.batchIndex]
    return !sameWordSet(record.sourceWordIds, expected)
  }).map((record) => ({
    ...record,
    status: 'skipped' as const,
    skippedAt: now,
    error: undefined,
    errorCode: undefined,
    updatedAt: now,
  }))
  if (!stale.length) return
  await db.readingSessions.bulkPut(stale)
  for (const record of stale) await markPayloadChanged('readingSessions', record, now)
}

/**
 * Rebuilds everything the learner has not started yet from the latest study
 * data. A started round stays intact; an untouched first round may be replaced
 * outright. This is also the escape hatch for the old, full-day fixed queue.
 */
export async function replanUnstartedDailyQueue(sessionId: string, at = new Date()): Promise<DailyQueueSnapshot> {
  const session = await db.dailyLearningSessions.get(sessionId)
  if (!session) throw new Error('今日学习会话不存在')
  if (session.status === 'completed') return loadDailyQueueSnapshot(sessionId)

  // V2 sessions are already split into stable learning units. Rebuilding their
  // untouched tail with the legacy round planner can orphan unit membership and
  // move the learner back to an earlier stage. Apply only the real source delta
  // and leave every started/future unit structurally intact.
  if (session.engineVersion === ENGINE_VERSION) {
    const preview = await previewDailyQueueChanges(sessionId, at)
    return preview.addedWordIds.length || preview.removedWordIds.length
      ? applyDailyQueueChanges(sessionId, at)
      : loadDailyQueueSnapshot(sessionId, at)
  }

  const [items, attempts, settings, revision, eligibleWordIds] = await Promise.all([
    orderedItems(sessionId),
    db.dailyQueueAttempts.where('sessionId').equals(sessionId).toArray(),
    loadSettings(),
    getStudyQueueRevision(),
    listEligibleStudyWordIds([], session.selectedListIds.length ? session.selectedListIds : undefined, at),
  ])
  const activeRoundIndex = session.activeRoundIndex
    ?? items.filter((item) => item.kind === 'card' && (item.status === 'pending' || item.status === 'active'))
      .map((item) => item.roundIndex ?? 1)
      .sort((left, right) => left - right)[0]
    ?? 1
  const hasStarted = attempts.length > 0
  const activeRoundWordIds = new Set(items
    .filter((item) => item.kind === 'card' && item.wordId && item.roundIndex === activeRoundIndex)
    .map((item) => item.wordId!))
  const attemptedWordIds = new Set(attempts.map((attempt) => attempt.wordId))
  const lockedWordIds = hasStarted
    ? new Set([...activeRoundWordIds, ...attemptedWordIds])
    : new Set<string>()
  const lockedInitialItems = items.filter((item) => item.kind === 'card' && item.wordId && item.reason === 'initial' && lockedWordIds.has(item.wordId))
  const firstInitialByWord = new Map<string, DailyQueueItem>()
  for (const item of lockedInitialItems) if (item.wordId && !firstInitialByWord.has(item.wordId)) firstInitialByWord.set(item.wordId, item)
  const lockedNew = [...firstInitialByWord.values()].filter((item) => item.wasNew).length
  const lockedReview = firstInitialByWord.size - lockedNew
  const plan = await buildTodayPlan({
    at,
    listIds: session.selectedListIds.length ? session.selectedListIds : undefined,
    excludeWordIds: [...lockedWordIds],
    dailyNewLimit: Math.max(0, Math.floor(settings.dailyNewLimit) - lockedNew),
    dailyReviewLimit: Math.max(0, Math.floor(settings.dailyReviewLimit) - lockedReview),
    promoteImportBacklog: true,
  })
  const refreshedWordIds = plan.queueWordIds
  const now = at.toISOString()
  const skipped = items
    .filter((item) => (item.status === 'pending' || item.status === 'active') && (!item.wordId || !lockedWordIds.has(item.wordId)))
    .map((item) => ({ ...item, status: 'skipped' as const, updatedAt: now }))

  let freshItems: DailyQueueItem[] = []
  let updatedRounds = parseRounds(session.roundsJson)
  let nextActiveRoundIndex = activeRoundIndex
  if (refreshedWordIds.length) {
    const states = await db.reviewState.bulkGet(refreshedWordIds)
    const roundBase = hasStarted ? activeRoundIndex : 0
    freshItems = createInitialQueueItems(session, refreshedWordIds, states, at, roundBase + 1).map((item, index) => ({
      ...item,
      itemId: `${sessionId}:refresh:${crypto.randomUUID()}:${index}`,
      position: items.reduce((max, row) => Math.max(max, row.position), -1) + 1 + index,
      roundIndex: roundBase + Math.floor(index / settings.roundWordCount) + 1,
    }))
    nextActiveRoundIndex = hasStarted ? activeRoundIndex : 1
    const retainedRounds = hasStarted
      ? updatedRounds.filter((round) => round.index <= activeRoundIndex).map((round) => round.index === activeRoundIndex ? { ...round, status: 'active' as const } : round)
      : []
    updatedRounds = [...retainedRounds, ...Array.from({ length: Math.ceil(refreshedWordIds.length / settings.roundWordCount) }, (_, index) => ({
      index: roundBase + index + 1,
      wordIds: refreshedWordIds.slice(index * settings.roundWordCount, index * settings.roundWordCount + settings.roundWordCount),
      status: !hasStarted && index === 0 ? 'active' as const : 'pending' as const,
      startedAt: !hasStarted && index === 0 ? now : '',
    }))]
  } else {
    updatedRounds = updatedRounds
      .filter((round) => round.index <= activeRoundIndex)
      .map((round) => round.index === activeRoundIndex ? { ...round, status: 'active' as const } : round)
  }
  const retainedWordIds = [...new Set(items
    .filter((item) => item.kind === 'card' && item.wordId && (item.status === 'completed' || lockedWordIds.has(item.wordId)))
    .map((item) => item.wordId!))]
  const updated: DailyLearningSession = {
    ...session,
    status: 'active',
    phase: 'cards',
    activeRoundIndex: nextActiveRoundIndex,
    roundsJson: JSON.stringify(updatedRounds),
    initialWordIds: [...retainedWordIds, ...refreshedWordIds].filter((wordId, index, rows) => rows.indexOf(wordId) === index),
    sourceRevision: revision,
    sourceEligibleWordIds: eligibleWordIds,
    dismissedSourceRevision: undefined,
    cardsCompletedAt: undefined,
    articleStatus: articleStatusAfterExtension(session.articleStatus),
    readingBatchesJson: undefined,
    activeReadingBatchIndex: undefined,
    completedAt: undefined,
    updatedAt: now,
  }
  await db.transaction('rw', [db.dailyLearningSessions, db.dailyQueueItems], async () => {
    if (skipped.length) await db.dailyQueueItems.bulkPut(skipped)
    if (freshItems.length) await db.dailyQueueItems.bulkPut(freshItems)
    await db.dailyLearningSessions.put(updated)
  })
  for (const item of [...skipped, ...freshItems]) await markPayloadChanged('dailyQueueItems', item, now)
  await markPayloadChanged('dailyLearningSessions', updated, now)
  await invalidateChangedFutureContent(updated, updatedRounds, settings, now)
  const activeRoundStillHasCards = freshItems.some((item) => item.kind === 'card'
    && (item.status === 'pending' || item.status === 'active')
    && (item.roundIndex ?? 1) === nextActiveRoundIndex)
    || items.some((item) => item.kind === 'card'
      && (item.status === 'pending' || item.status === 'active')
      && (item.roundIndex ?? 1) === activeRoundIndex
      && lockedWordIds.has(item.wordId ?? ''))
  if (!activeRoundStillHasCards) await advanceToPlannedRound(sessionId, at)
  return loadDailyQueueSnapshot(sessionId)
}

function articleStatusAfterExtension(status: DailyLearningSession['articleStatus']): DailyLearningSession['articleStatus'] {
  if (status === 'ready' || status === 'completed' || status === 'generating' || status === 'stale') return 'stale'
  if (status === 'failed' || status === 'skipped') return 'waiting'
  return status
}

async function createAppendedItems(
  session: DailyLearningSession,
  wordIds: string[],
  reason: 'list-change' | 'extra-batch',
  at: Date,
  startRoundIndex = session.activeRoundIndex ?? 1,
  roundWordCount = DEFAULT_DAILY_ROUND_SIZE,
): Promise<DailyQueueItem[]> {
  if (!wordIds.length) return []
  const [states, existingItems] = await Promise.all([
    db.reviewState.bulkGet(wordIds),
    orderedItems(session.sessionId),
  ])
  const startPosition = existingItems.reduce((max, item) => Math.max(max, item.position), -1) + 1
  return createInitialQueueItems(session, wordIds, states, at).map((item, index) => ({
    ...item,
    itemId: `${session.sessionId}:card:${reason}:${crypto.randomUUID()}`,
    reason,
    position: startPosition + index,
    roundIndex: startRoundIndex + Math.floor(index / roundWordCount),
  }))
}

async function createV2AppendedContent(
  session: DailyLearningSession,
  wordIds: string[],
  reason: 'list-change' | 'extra-batch',
  at: Date,
  unitSize: number,
): Promise<{ items: DailyQueueItem[]; units: LearningUnit[]; orderedWordIds: string[] }> {
  const [states, existingItems] = await Promise.all([
    db.reviewState.bulkGet(wordIds),
    orderedItems(session.sessionId),
  ])
  const plan = buildLearningUnits(session.sessionId, wordIds, states, unitSize)
  const existingUnits = parseLearningUnits(session.unitsJson)
  const offset = existingUnits.length
  const reopens = session.status === 'completed'
  const appended = plan.units.map((unit, index) => ({
    ...unit,
    unitId: `${session.sessionId}:unit:${offset + index + 1}`,
    index: offset + index,
    status: reopens && index === 0 ? 'active' as const : 'pending' as const,
  }))
  const units = [...existingUnits, ...appended]
  const sessionWithUnits = { ...session, unitsJson: JSON.stringify(units) }
  const startPosition = existingItems.reduce((max, item) => Math.max(max, item.position), -1) + 1
  const items = createInitialQueueItems(sessionWithUnits, plan.orderedWordIds, plan.orderedStates, at)
    .map((item, index) => ({
      ...item,
      itemId: `${session.sessionId}:card:${reason}:${crypto.randomUUID()}`,
      reason,
      position: startPosition + index,
    }))
  return { items, units, orderedWordIds: plan.orderedWordIds }
}

function roundsFromUnits(units: LearningUnit[], now: string): string {
  return JSON.stringify(units.map((unit) => ({
    index: unit.index + 1,
    wordIds: unit.wordIds,
    status: unit.status,
    startedAt: unit.status === 'active' ? now : '',
  })))
}

function appendPlannedRounds(
  raw: string | undefined,
  wordIds: string[],
  startRoundIndex: number,
  roundWordCount: number,
): string {
  const retained = parseRounds(raw).filter((round) => round.index < startRoundIndex)
  const appended = Array.from({ length: Math.ceil(wordIds.length / roundWordCount) }, (_, index) => ({
    index: startRoundIndex + index,
    wordIds: wordIds.slice(index * roundWordCount, index * roundWordCount + roundWordCount),
    status: 'pending' as const,
    startedAt: '',
  }))
  return JSON.stringify([...retained, ...appended])
}

export async function applyDailyQueueChanges(sessionId: string, at = new Date()): Promise<DailyQueueSnapshot> {
  const session = await db.dailyLearningSessions.get(sessionId)
  if (!session) throw new Error('今日学习会话不存在')
  const preview = await previewDailyQueueChanges(sessionId, at)
  const now = at.toISOString()
  const removedSet = new Set(preview.removedWordIds)
  const existingItems = await db.dailyQueueItems.where('sessionId').equals(sessionId).toArray()
  const skippedItems = existingItems
    .filter((item) => item.wordId && removedSet.has(item.wordId) && (item.status === 'pending' || item.status === 'active'))
    .map((item) => ({ ...item, status: 'skipped' as const, updatedAt: now }))
  const settings = await loadSettings()
  const existingRounds = parseRounds(session.roundsJson)
  const startRoundIndex = Math.max(session.activeRoundIndex ?? 1, ...existingRounds.map((round) => round.index), 0) + 1
  const prunedUnits = parseLearningUnits(session.unitsJson).map((unit) => ({
    ...unit,
    wordIds: unit.wordIds.filter((wordId) => !removedSet.has(wordId)),
    dueWordIds: unit.dueWordIds.filter((wordId) => !removedSet.has(wordId)),
    newWordIds: unit.newWordIds.filter((wordId) => !removedSet.has(wordId)),
  }))
  const baseSession = session.engineVersion === ENGINE_VERSION
    ? { ...session, unitsJson: JSON.stringify(prunedUnits) }
    : session
  const v2Append = session.engineVersion === ENGINE_VERSION
    ? await createV2AppendedContent(baseSession, preview.addedWordIds, 'list-change', at, settings.roundWordCount)
    : undefined
  const addedItems = v2Append?.items
    ?? await createAppendedItems(session, preview.addedWordIds, 'list-change', at, startRoundIndex, settings.roundWordCount)
  const addedSet = new Set(preview.addedWordIds)
  const membershipsToActivate = (await db.studyListItems.toArray())
    .filter((membership) => addedSet.has(membership.wordId) && membership.autoActivate === 1)
    .map((membership) => ({ ...membership, learningEnabled: 1 as const, autoActivate: 0 as const }))
  const updated: DailyLearningSession = {
    ...session,
    status: addedItems.length ? 'active' : session.status,
    phase: addedItems.length && session.status === 'completed' ? 'cards' : session.phase,
    learningStage: addedItems.length && session.status === 'completed' && session.engineVersion === ENGINE_VERSION
      ? 'probe'
      : session.learningStage,
    activeUnitIndex: addedItems.length && session.status === 'completed' && v2Append
      ? prunedUnits.length
      : session.activeUnitIndex,
    activeRoundIndex: addedItems.length && session.status === 'completed' && v2Append
      ? prunedUnits.length + 1
      : session.activeRoundIndex,
    unitsJson: v2Append ? JSON.stringify(v2Append.units) : (
      session.engineVersion === ENGINE_VERSION ? JSON.stringify(prunedUnits) : session.unitsJson
    ),
    roundsJson: v2Append
      ? roundsFromUnits(v2Append.units, now)
      : session.engineVersion === ENGINE_VERSION
        ? roundsFromUnits(prunedUnits, now)
      : addedItems.length
        ? appendPlannedRounds(session.roundsJson, preview.addedWordIds, startRoundIndex, settings.roundWordCount)
        : session.roundsJson,
    initialWordIds: [...session.initialWordIds.filter((wordId) => !removedSet.has(wordId)), ...(v2Append?.orderedWordIds ?? preview.addedWordIds)]
      .filter((wordId, index, rows) => rows.indexOf(wordId) === index),
    sourceRevision: preview.revision,
    sourceEligibleWordIds: preview.eligibleWordIds,
    dismissedSourceRevision: undefined,
    cardsCompletedAt: addedItems.length ? undefined : session.cardsCompletedAt,
    articleStatus: addedItems.length ? articleStatusAfterExtension(session.articleStatus) : session.articleStatus,
    readingBatchesJson: addedItems.length ? undefined : session.readingBatchesJson,
    activeReadingBatchIndex: addedItems.length ? undefined : session.activeReadingBatchIndex,
    completedAt: addedItems.length ? undefined : session.completedAt,
    sessionRevision: (session.sessionRevision ?? 0) + 1,
    updatedAt: now,
  }
  await db.transaction('rw', [db.dailyLearningSessions, db.dailyQueueItems, db.studyListItems], async () => {
    if (skippedItems.length) await db.dailyQueueItems.bulkPut(skippedItems)
    if (addedItems.length) await db.dailyQueueItems.bulkPut(addedItems)
    if (membershipsToActivate.length) await db.studyListItems.bulkPut(membershipsToActivate)
    await db.dailyLearningSessions.put(updated)
  })
  for (const item of [...skippedItems, ...addedItems]) await markPayloadChanged('dailyQueueItems', item, now)
  for (const membership of membershipsToActivate) await markPayloadChanged('studyListItems', membership, now)
  await markPayloadChanged('dailyLearningSessions', updated, now)
  await advanceSessionIfCardsDone(sessionId, at)
  return loadDailyQueueSnapshot(sessionId, at)
}

export async function extendDailyQueue(sessionId: string, count: number, at = new Date()): Promise<DailyQueueSnapshot> {
  const session = await db.dailyLearningSessions.get(sessionId)
  if (!session) throw new Error('今日学习会话不存在')
  const wordIds = await buildAdditionalStudyWordIds(
    count,
    session.initialWordIds,
    session.selectedListIds.length ? session.selectedListIds : undefined,
    at,
  )
  if (!wordIds.length) return loadDailyQueueSnapshot(sessionId)
  const [settings, existingRounds] = await Promise.all([loadSettings(), Promise.resolve(parseRounds(session.roundsJson))])
  const startRoundIndex = Math.max(session.activeRoundIndex ?? 1, ...existingRounds.map((round) => round.index), 0) + 1
  const now = at.toISOString()
  const v2Append = session.engineVersion === ENGINE_VERSION
    ? await createV2AppendedContent(session, wordIds, 'extra-batch', at, settings.roundWordCount)
    : undefined
  const items = v2Append?.items
    ?? await createAppendedItems(session, wordIds, 'extra-batch', at, startRoundIndex, settings.roundWordCount)
  const updated: DailyLearningSession = {
    ...session,
    status: 'active',
    phase: session.status === 'completed' ? 'cards' : session.phase,
    learningStage: session.status === 'completed' && session.engineVersion === ENGINE_VERSION ? 'probe' : session.learningStage,
    activeUnitIndex: session.status === 'completed' && v2Append
      ? parseLearningUnits(session.unitsJson).length
      : session.activeUnitIndex,
    activeRoundIndex: session.status === 'completed' && v2Append
      ? parseLearningUnits(session.unitsJson).length + 1
      : session.activeRoundIndex,
    unitsJson: v2Append ? JSON.stringify(v2Append.units) : session.unitsJson,
    initialWordIds: [...session.initialWordIds, ...(v2Append?.orderedWordIds ?? wordIds)],
    extensionBatchCount: (session.extensionBatchCount ?? 0) + 1,
    roundsJson: v2Append
      ? roundsFromUnits(v2Append.units, now)
      : appendPlannedRounds(session.roundsJson, wordIds, startRoundIndex, settings.roundWordCount),
    cardsCompletedAt: undefined,
    articleStatus: articleStatusAfterExtension(session.articleStatus),
    readingBatchesJson: undefined,
    activeReadingBatchIndex: undefined,
    completedAt: undefined,
    sessionRevision: (session.sessionRevision ?? 0) + 1,
    updatedAt: now,
  }
  await db.transaction('rw', [db.dailyLearningSessions, db.dailyQueueItems], async () => {
    await db.dailyQueueItems.bulkPut(items)
    await db.dailyLearningSessions.put(updated)
  })
  for (const item of items) await markPayloadChanged('dailyQueueItems', item, now)
  await markPayloadChanged('dailyLearningSessions', updated, now)
  await advanceSessionIfCardsDone(sessionId, at)
  return loadDailyQueueSnapshot(sessionId, at)
}

function selectCurrentItem(
  session: DailyLearningSession,
  items: DailyQueueItem[],
  attempts: DailyQueueAttempt[],
  at: Date,
): { current?: DailyQueueItem; nextAvailableAt?: string; waitingForActivities?: number } {
  if (session.phase !== 'cards') return {}
  if (session.engineVersion !== ENGINE_VERSION) {
    const activeRoundIndex = session.activeRoundIndex ?? 1
    return {
      current: items.find((item) => item.kind === 'card'
        && (item.status === 'pending' || item.status === 'active')
        && (item.roundIndex ?? activeRoundIndex) === activeRoundIndex),
    }
  }

  const activityOrdinal = session.activityOrdinal ?? 0
  const activeUnit = parseLearningUnits(session.unitsJson)[session.activeUnitIndex ?? 0]
  const activeStage = session.learningStage ?? 'probe'
  const candidates = items.filter((item) => {
    if (item.kind !== 'card' || (item.status !== 'pending' && item.status !== 'active')) return false
    if (item.stage === 'retry') return true
    return item.unitId === activeUnit?.unitId && item.stage === activeStage
  })
  const bySchedule = [...candidates].sort((left, right) =>
    (left.eligibleAfterOrdinal ?? 0) - (right.eligibleAfterOrdinal ?? 0)
    || (left.notBeforeAt ?? '').localeCompare(right.notBeforeAt ?? '')
    || left.position - right.position)
  const eligible = bySchedule.filter((item) =>
    (item.eligibleAfterOrdinal ?? 0) <= activityOrdinal
    && (!item.notBeforeAt || Date.parse(item.notBeforeAt) <= at.getTime()))
    .sort((left, right) =>
      Number(right.stage === 'retry') - Number(left.stage === 'retry')
      || (left.eligibleAfterOrdinal ?? 0) - (right.eligibleAfterOrdinal ?? 0)
      || left.position - right.position)
  const lastWordId = attempts[attempts.length - 1]?.wordId
  const current = eligible.find((item) => item.wordId !== lastWordId) ?? eligible[0]
  const futureTimes = candidates
    .filter((item) => (item.eligibleAfterOrdinal ?? 0) <= activityOrdinal && item.notBeforeAt)
    .map((item) => item.notBeforeAt!)
    .filter((value) => Date.parse(value) > at.getTime())
    .sort()
  const futureOrdinals = candidates
    .map((item) => item.eligibleAfterOrdinal ?? 0)
    .filter((ordinal) => ordinal > activityOrdinal)
  return {
    current,
    nextAvailableAt: current ? undefined : futureTimes[0],
    waitingForActivities: current || !futureOrdinals.length
      ? undefined
      : Math.max(1, Math.min(...futureOrdinals) - activityOrdinal),
  }
}

export async function loadDailyQueueSnapshot(sessionId: string, at = new Date()): Promise<DailyQueueSnapshot> {
  const session = await db.dailyLearningSessions.get(sessionId)
  if (!session) throw new Error('今日学习会话不存在')
  const [items, attempts] = await Promise.all([
    orderedItems(sessionId),
    db.dailyQueueAttempts.where('sessionId').equals(sessionId).sortBy('answeredAt'),
  ])
  const cardItems = items.filter((item) => item.kind === 'card')
  const remainingWordIds = new Set(cardItems
    .filter((item) => item.wordId && (item.status === 'pending' || item.status === 'active'))
    .map((item) => item.wordId!))
  const selection = selectCurrentItem(session, items, attempts, at)
  return {
    session,
    items,
    attempts,
    ...selection,
    completedCards: [...new Set(session.initialWordIds)].filter((wordId) => !remainingWordIds.has(wordId)).length,
    totalCards: new Set(session.initialWordIds).size,
  }
}

export async function getOrCreateDailySession(listIds?: string[], at = new Date()): Promise<DailyQueueSnapshot> {
  const today = dayKey(at)
  const storedSession = await db.dailyLearningSessions.where('dayKey').equals(today).first()
  if (storedSession) {
    const revision = await getStudyQueueRevision()
    let existing: DailyLearningSession = storedSession.sourceRevision ? storedSession : {
      ...storedSession,
      sourceRevision: revision,
      sourceEligibleWordIds: await listEligibleStudyWordIds([], storedSession.selectedListIds.length ? storedSession.selectedListIds : undefined, at),
      baseWordCount: storedSession.initialWordIds.length,
      extensionBatchCount: 0,
      updatedAt: at.toISOString(),
    }
    if (existing !== storedSession) {
      await db.dailyLearningSessions.put(existing)
      await markPayloadChanged('dailyLearningSessions', existing, existing.updatedAt)
    }
    existing = await repairPersistedRounds(existing, at)
    await repairVocabularyIntegrity(existing.initialWordIds)
    const words = await db.wordbook.bulkGet(existing.initialWordIds)
    const validIds = words.filter((word) => word && word.integrityStatus !== 'needs-repair').map((word) => word!.wordId)
    const unresolved = new Set(existing.initialWordIds.filter((wordId) => !validIds.includes(wordId)))
    if (unresolved.size) {
      const now = at.toISOString()
      const items = await db.dailyQueueItems.where('sessionId').equals(existing.sessionId).toArray()
      const skipped = items.filter((item) => item.wordId && unresolved.has(item.wordId) && (item.status === 'pending' || item.status === 'active'))
        .map((item) => ({ ...item, status: 'skipped' as const, updatedAt: now }))
      if (skipped.length) await db.dailyQueueItems.bulkPut(skipped)
      const updatedSession = { ...existing, initialWordIds: validIds, updatedAt: now }
      await db.dailyLearningSessions.put(updatedSession)
      for (const item of skipped) await markPayloadChanged('dailyQueueItems', item, now)
      await markPayloadChanged('dailyLearningSessions', updatedSession, now)
      await advanceSessionIfCardsDone(existing.sessionId)
    }
    await advanceSessionIfCardsDone(existing.sessionId, at)
    return loadDailyQueueSnapshot(existing.sessionId, at)
  }

  const plan = await buildTodayPlan({ listIds, at })
  const settings = await loadSettings()
  const plannedWordIds = plan.queueWordIds
  const [states, revision] = await Promise.all([
    db.reviewState.bulkGet(plannedWordIds),
    getStudyQueueRevision(),
  ])
  const now = at.toISOString()
  const unitPlan = buildLearningUnits(`daily:${today}`, plannedWordIds, states, settings.roundWordCount)
  const orderedWordIds = unitPlan.orderedWordIds
  const session: DailyLearningSession = {
    sessionId: `daily:${today}`,
    dayKey: today,
    status: 'active',
    phase: orderedWordIds.length ? 'cards' : 'summary',
    engineVersion: ENGINE_VERSION,
    sessionRevision: 1,
    activityOrdinal: 0,
    learningStage: 'probe',
    activeUnitIndex: 0,
    unitsJson: JSON.stringify(unitPlan.units),
    selectedListIds: listIds ?? plan.listIds ?? [],
    initialWordIds: orderedWordIds,
    sourceRevision: revision,
    sourceEligibleWordIds: plan.eligibleWordIds ?? plan.queueWordIds,
    baseWordCount: plan.queueWordIds.length,
    extensionBatchCount: 0,
    activeRoundIndex: orderedWordIds.length ? 1 : 0,
    roundsJson: JSON.stringify(unitPlan.units.map((unit) => ({
      index: unit.index + 1,
      wordIds: unit.wordIds,
      status: unit.status,
      startedAt: unit.status === 'active' ? now : '',
    }))),
    articleStatus: 'waiting',
    recoveryMode: plan.recoveryMode,
    recoveryBacklogCount: plan.backlogDueCount,
    recoveryDays: plan.recoveryDays,
    recoveryCalibrationCount: 0,
    createdAt: now,
    updatedAt: now,
  }
  const items = createInitialQueueItems(session, orderedWordIds, unitPlan.orderedStates, at)

  await db.transaction('rw', [db.dailyLearningSessions, db.dailyQueueItems], async () => {
    await db.dailyLearningSessions.add(session)
    if (items.length) await db.dailyQueueItems.bulkAdd(items)
  })
  await markPayloadChanged('dailyLearningSessions', session, now)
  for (const item of items) await markPayloadChanged('dailyQueueItems', item, now)
  await advanceSessionIfCardsDone(session.sessionId, at)
  return loadDailyQueueSnapshot(session.sessionId, at)
}

/**
 * Adds a word to today's relearning flow without erasing its review history.
 * The command is idempotent: an existing pending relearn item is reused.
 */
export async function requestWordRelearning(
  wordId: string,
  at = new Date(),
  options: { commitCanonicalAgain?: boolean; treatAsNew?: boolean } = {},
): Promise<DailyQueueSnapshot> {
  const state = await db.reviewState.get(wordId)
  if (!state) throw new Error('单词学习状态不存在')
  const now = at.toISOString()
  const today = dayKey(at)

  let session = await db.dailyLearningSessions.where('dayKey').equals(today).first()
  if (!session) session = (await getOrCreateDailySession(undefined, at)).session

  await db.transaction('rw', [
    db.dailyLearningSessions,
    db.dailyQueueItems,
    db.dailyQueueAttempts,
    db.reviewState,
    db.reviewLogs,
    db.syncMeta,
    db.syncRecords,
    db.syncTombstones,
  ], async () => {
    const currentSession = await db.dailyLearningSessions.get(session!.sessionId)
    if (!currentSession) throw new Error('今日学习会话不存在')
    const commandState = await db.reviewState.get(wordId)
    if (!commandState) throw new Error('单词学习状态不存在')
    await db.reviewState.put({
      ...commandState,
      suspendedAt: undefined,
      sameDayRelearnAt: now,
    })
    await markRecordChanged('reviewState', wordId, now)
    const sessionItems = await db.dailyQueueItems.where('sessionId').equals(currentSession.sessionId).toArray()
    const duplicate = sessionItems.find((item) => item.wordId === wordId
      && item.reason === 'reencounter'
      && (item.status === 'pending' || item.status === 'active'))
    if (duplicate) {
      const latestState = await db.reviewState.get(wordId)
      if (latestState?.sameDayRelearnAt) {
        await db.reviewState.put({ ...latestState, sameDayRelearnAt: undefined })
        await markRecordChanged('reviewState', wordId, now)
      }
      return
    }

    const attempts = await db.dailyQueueAttempts
      .where('[sessionId+wordId]')
      .equals([currentSession.sessionId, wordId])
      .toArray()
    const dayStart = dayjs(at).startOf('day').toISOString()
    const dayEnd = dayjs(at).add(1, 'day').startOf('day').toISOString()
    const todaysLogs = await db.reviewLogs
      .where('[wordId+reviewedAt]')
      .between([wordId, dayStart], [wordId, dayEnd], true, false)
      .toArray()
    const hasCanonicalGrade = attempts.some((attempt) => attempt.committedToFsrs)
      || todaysLogs.some((log) => log.source !== 'manual-relearn')

    let units = parseLearningUnits(currentSession.unitsJson)
    const activeIndex = currentSession.activeUnitIndex ?? 0
    let targetUnit = units.find((unit) => unit.wordIds.includes(wordId)
      && !unit.articleCompletedAt
      && unit.status !== 'completed')
    const canJoinActiveUnit = currentSession.status === 'active'
      && currentSession.phase === 'cards'
      && (currentSession.learningStage ?? 'probe') === 'probe'
      && units[activeIndex]
      && !units[activeIndex]!.articleCompletedAt
    if (!targetUnit && canJoinActiveUnit) targetUnit = units[activeIndex]
    if (!targetUnit) {
      const index = units.length
      targetUnit = {
        unitId: `${currentSession.sessionId}:unit:${index + 1}`,
        index,
        wordIds: [],
        dueWordIds: [],
        newWordIds: [],
        status: currentSession.status === 'completed' ? 'active' : 'pending',
      }
      units = [...units, targetUnit]
    }
    units = units.map((unit) => unit.unitId === targetUnit!.unitId
      ? {
          ...unit,
          wordIds: [...new Set([...unit.wordIds, wordId])],
          dueWordIds: unit.dueWordIds.filter((id) => id !== wordId),
          newWordIds: [...new Set([...unit.newWordIds, wordId])],
        }
      : unit)
    targetUnit = units.find((unit) => unit.unitId === targetUnit!.unitId)!

    const existing = sessionItems.find((item) => item.wordId === wordId
      && (item.status === 'pending' || item.status === 'active'))
    const position = Math.max(-1, ...sessionItems.map((item) => item.position)) + 1
    const retrievability = options.treatAsNew ? 0 : getReviewRetrievability(commandState, at)
    const queueItem: DailyQueueItem = {
      ...(existing ?? {
        itemId: `${currentSession.sessionId}:reencounter:${wordId}:${crypto.randomUUID()}`,
        sessionId: currentSession.sessionId,
        kind: 'card' as const,
        wordId,
        position,
        status: 'pending' as const,
        attemptNo: 1,
        maxAttempts: MAX_DAILY_ATTEMPTS,
        retrievability,
        startingLongTermRetrievability: retrievability,
        wasNew: options.treatAsNew ?? false,
        todayMastery: 0,
        recallStreak: 0,
        weakSeen: true,
        attemptCount: 0,
        nextGap: 0,
        tomorrowPriority: false,
        createdAt: now,
      }),
      reason: 'reencounter',
      roundIndex: targetUnit.index + 1,
      unitId: targetUnit.unitId,
      stage: 'learn',
      eligibleAfterOrdinal: currentSession.activityOrdinal ?? 0,
      notBeforeAt: now,
      canonicalGradeCommitted: hasCanonicalGrade,
      memoryStatus: 'pending',
      status: 'pending',
      updatedAt: now,
    }

    let committedToFsrs = false
    if (!hasCanonicalGrade && options.commitCanonicalAgain !== false) {
      const prepared = await prepareCardGrade(
        wordId,
        'again',
        at,
        { attemptCount: 1, ratings: ['again'], masteryBefore: 0, masteryAfter: 0 },
        'manual-relearn',
      )
      await persistPreparedCardGrade(prepared)
      committedToFsrs = true
      queueItem.canonicalGradeCommitted = true
    } else {
      const latestState = await db.reviewState.get(wordId)
      if (latestState?.sameDayRelearnAt) {
        const cleared = { ...latestState, sameDayRelearnAt: undefined }
        await db.reviewState.put(cleared)
        await markRecordChanged('reviewState', wordId, now)
      }
    }

    const activityOrdinal = (currentSession.activityOrdinal ?? 0) + 1
    const manualAttempt: DailyQueueAttempt = {
      attemptId: `${currentSession.sessionId}:${wordId}:manual-relearn`,
      sessionId: currentSession.sessionId,
      itemId: queueItem.itemId,
      wordId,
      rating: 'again',
      committedToFsrs,
      masteryBefore: 0,
      masteryAfter: 0,
      reinsertionGap: 0,
      effectiveFsrsRating: committedToFsrs ? 'again' : undefined,
      activityOrdinal,
      evidenceKind: 'manual-relearn',
      skill: 'meaning-recall',
      hintLevel: 0,
      answeredAt: now,
    }
    const reopensCompletedSession = currentSession.status === 'completed'
    const rounds = units.map((unit) => ({
      index: unit.index + 1,
      wordIds: unit.wordIds,
      status: unit.status,
      startedAt: unit.status === 'active' ? now : '',
    }))
    const updatedSession: DailyLearningSession = {
      ...currentSession,
      engineVersion: ENGINE_VERSION,
      status: 'active',
      phase: reopensCompletedSession ? 'article' : currentSession.phase,
      learningStage: reopensCompletedSession ? 'read' : currentSession.learningStage,
      activeUnitIndex: reopensCompletedSession ? targetUnit.index : currentSession.activeUnitIndex,
      activeRoundIndex: reopensCompletedSession ? targetUnit.index + 1 : currentSession.activeRoundIndex,
      initialWordIds: [...new Set([...currentSession.initialWordIds, wordId])],
      unitsJson: JSON.stringify(units),
      roundsJson: JSON.stringify(rounds),
      activityOrdinal,
      sessionRevision: (currentSession.sessionRevision ?? 0) + 1,
      cardsCompletedAt: undefined,
      completedAt: undefined,
      articleStatus: reopensCompletedSession ? 'waiting' : (
        currentSession.articleStatus === 'ready' || currentSession.articleStatus === 'generating'
          ? 'stale'
          : currentSession.articleStatus
      ),
      updatedAt: now,
    }
    await db.dailyQueueItems.put(queueItem)
    await db.dailyQueueAttempts.put(manualAttempt)
    await db.dailyLearningSessions.put(updatedSession)
    await markPayloadChanged('dailyQueueItems', queueItem, now)
    await markPayloadChanged('dailyQueueAttempts', manualAttempt, now)
    await markPayloadChanged('dailyLearningSessions', updatedSession, now)
  })

  await advanceSessionIfCardsDone(session.sessionId, at)
  return loadDailyQueueSnapshot(session.sessionId, at)
}

async function appendNewlyDueWords(sessionId: string, at: Date): Promise<void> {
  const [session, settings] = await Promise.all([
    db.dailyLearningSessions.get(sessionId),
    loadSettings(),
  ])
  if (!session || session.status === 'rolled-over' || session.engineVersion !== ENGINE_VERSION) return
  const initialItems = await db.dailyQueueItems.where('sessionId').equals(sessionId).toArray()
  const includedDueCount = new Set(initialItems
    .filter((item) => item.kind === 'card' && item.wordId && !item.wasNew && item.reason !== 'reencounter')
    .map((item) => item.wordId!)).size
  const remainingReviewSlots = Math.max(0, Math.floor(settings.dailyReviewLimit) - includedDueCount)
  if (!remainingReviewSlots) return
  const plan = await buildTodayPlan({
    at,
    listIds: session.selectedListIds.length ? session.selectedListIds : undefined,
    excludeWordIds: session.initialWordIds,
    dailyNewLimit: 0,
    dailyReviewLimit: remainingReviewSlots,
    promoteImportBacklog: false,
  })
  if (!plan.queueWordIds.length) return

  const now = at.toISOString()
  await db.transaction('rw', [
    db.dailyLearningSessions,
    db.dailyQueueItems,
    db.reviewState,
    db.syncMeta,
    db.syncRecords,
    db.syncTombstones,
  ], async () => {
    // Re-read every mutable input while holding the IndexedDB write
    // transaction. Concurrent tabs are serialized on these stores, so the
    // second reconciliation observes the first one's additions and becomes a
    // no-op instead of creating duplicate random item IDs.
    const currentSession = await db.dailyLearningSessions.get(sessionId)
    if (!currentSession || currentSession.status === 'rolled-over') return
    const currentItems = await db.dailyQueueItems.where('sessionId').equals(sessionId).toArray()
    const currentWordIds = new Set(currentSession.initialWordIds)
    const currentDueCount = new Set(currentItems
      .filter((item) => item.kind === 'card' && item.wordId && !item.wasNew && item.reason !== 'reencounter')
      .map((item) => item.wordId!)).size
    const availableSlots = Math.max(0, Math.floor(settings.dailyReviewLimit) - currentDueCount)
    const appendWordIds = plan.queueWordIds
      .filter((wordId) => !currentWordIds.has(wordId))
      .slice(0, availableSlots)
    if (!appendWordIds.length) return

    const states = await db.reviewState.bulkGet(appendWordIds)
    const nextPlan = buildLearningUnits(
      sessionId,
      appendWordIds,
      states,
      settings.roundWordCount,
    )
    const existingUnits = parseLearningUnits(currentSession.unitsJson)
    const unitOffset = existingUnits.length
    const appendedUnits = nextPlan.units.map((unit, index) => ({
      ...unit,
      unitId: `${sessionId}:unit:${unitOffset + index + 1}`,
      index: unitOffset + index,
      status: currentSession.status === 'completed' && index === 0 ? 'active' as const : 'pending' as const,
    }))
    const units = [...existingUnits, ...appendedUnits]
    const updatedSession: DailyLearningSession = {
      ...currentSession,
      status: 'active',
      phase: currentSession.status === 'completed' ? 'cards' : currentSession.phase,
      learningStage: currentSession.status === 'completed' ? 'probe' : currentSession.learningStage,
      activeUnitIndex: currentSession.status === 'completed' ? unitOffset : currentSession.activeUnitIndex,
      activeRoundIndex: currentSession.status === 'completed' ? unitOffset + 1 : currentSession.activeRoundIndex,
      initialWordIds: [...currentSession.initialWordIds, ...nextPlan.orderedWordIds],
      sourceEligibleWordIds: [...new Set([...(currentSession.sourceEligibleWordIds ?? []), ...appendWordIds])],
      unitsJson: JSON.stringify(units),
      roundsJson: JSON.stringify(units.map((unit) => ({
        index: unit.index + 1,
        wordIds: unit.wordIds,
        status: unit.status,
        startedAt: unit.status === 'active' ? now : '',
      }))),
      sessionRevision: (currentSession.sessionRevision ?? 0) + 1,
      completedAt: undefined,
      cardsCompletedAt: undefined,
      updatedAt: now,
    }
    const lastPosition = Math.max(-1, ...currentItems.map((item) => item.position))
    const stateByWord = new Map(nextPlan.orderedWordIds.map((wordId, index) => [wordId, nextPlan.orderedStates[index]]))
    const items = createInitialQueueItems(
      updatedSession,
      nextPlan.orderedWordIds,
      nextPlan.orderedWordIds.map((wordId) => stateByWord.get(wordId)),
      at,
    ).map((item, index) => ({
      ...item,
      itemId: `${sessionId}:due-refresh:${item.wordId}:${crypto.randomUUID()}`,
      position: lastPosition + index + 1,
      reason: 'list-change' as const,
    }))
    await db.dailyLearningSessions.put(updatedSession)
    await db.dailyQueueItems.bulkPut(items)
    await markPayloadChanged('dailyLearningSessions', updatedSession, now)
    for (const item of items) await markPayloadChanged('dailyQueueItems', item, now)
  })
}

/**
 * Repairs day boundaries on startup, route activation, foreground resume and
 * midnight. Submitted evidence is retained; unfinished retries become today's
 * high-priority relearn evidence.
 */
export async function reconcileStudyDay(at = new Date()): Promise<DailyQueueSnapshot | undefined> {
  const today = dayKey(at)
  const existingToday = await db.dailyLearningSessions.where('dayKey').equals(today).first()
  const oldSessions = await db.dailyLearningSessions
    .where('dayKey')
    .below(today)
    .filter((session) => session.status === 'active')
    .toArray()
  const now = at.toISOString()
  for (const session of oldSessions) {
    const pending = await db.dailyQueueItems.where('sessionId').equals(session.sessionId)
      .filter((item) => item.status === 'pending' || item.status === 'active')
      .toArray()
    const retryWordIds = [...new Set(pending
      .filter((item) => item.wordId && item.stage === 'retry')
      .map((item) => item.wordId!))]
    await db.transaction('rw', [
      db.dailyLearningSessions,
      db.dailyQueueItems,
      db.reviewState,
      db.syncMeta,
      db.syncRecords,
      db.syncTombstones,
    ], async () => {
      const rolled: DailyLearningSession = {
        ...session,
        status: 'rolled-over',
        phase: 'summary',
        sessionRevision: (session.sessionRevision ?? 0) + 1,
        updatedAt: now,
      }
      const skipped = pending.map((item) => ({
        ...item,
        status: 'skipped' as const,
        memoryStatus: item.stage === 'retry' ? 'tomorrow' as const : item.memoryStatus,
        updatedAt: now,
      }))
      await db.dailyLearningSessions.put(rolled)
      if (skipped.length) await db.dailyQueueItems.bulkPut(skipped)
      for (const wordId of retryWordIds) {
        const state = await db.reviewState.get(wordId)
        if (!state) continue
        await db.reviewState.put({ ...state, sameDayRelearnAt: now })
        await markRecordChanged('reviewState', wordId, now)
      }
      await markPayloadChanged('dailyLearningSessions', rolled, now)
      for (const item of skipped) await markPayloadChanged('dailyQueueItems', item, now)
    })
  }

  if (!existingToday && !oldSessions.length) return undefined
  const snapshot = existingToday
    ? await getOrCreateDailySession(existingToday.selectedListIds, at)
    : await getOrCreateDailySession(undefined, at)
  await appendNewlyDueWords(snapshot.session.sessionId, at)
  await advanceSessionIfCardsDone(snapshot.session.sessionId, at)
  return loadDailyQueueSnapshot(snapshot.session.sessionId, at)
}

async function insertRepeat(
  current: DailyQueueItem,
  reason: DailyQueueReason,
  rating: ReviewRating,
  failureCount: number,
  activityOrdinal: number,
  at: Date,
  outcome: ShortTermReviewOutcome,
): Promise<DailyQueueItem> {
  const now = at.toISOString()
  const last = await db.dailyQueueItems.where('sessionId').equals(current.sessionId).last()
  const microReview = failureCount >= 2
  const delayMs = microReview
    ? MICRO_REVIEW_DELAY_MS
    : rating === 'hard' ? HARD_DELAY_MS : AGAIN_DELAY_MS
  const activityGap = microReview
    ? 1
    : rating === 'hard' ? HARD_MIN_ACTIVITY_GAP : AGAIN_MIN_ACTIVITY_GAP
  const item: DailyQueueItem = {
    ...current,
    itemId: `${current.sessionId}:card:${current.wordId}:${current.attemptNo + 1}:${crypto.randomUUID()}`,
    reason,
    stage: 'retry',
    eligibleAfterOrdinal: activityOrdinal + activityGap,
    notBeforeAt: new Date(at.getTime() + delayMs).toISOString(),
    canonicalGradeCommitted: true,
    memoryStatus: 'retry-later',
    position: Math.max(current.position, last?.position ?? -1) + 1,
    status: 'pending',
    attemptNo: current.attemptNo + 1,
    maxAttempts: MAX_DAILY_ATTEMPTS,
    todayMastery: outcome.mastery,
    recallStreak: outcome.recallStreak,
    weakSeen: outcome.weakSeen,
    attemptCount: current.attemptNo,
    nextGap: activityGap,
    coachingRequired: microReview,
    createdAt: now,
    updatedAt: now,
  }
  await db.dailyQueueItems.put(item)
  await markPayloadChanged('dailyQueueItems', item, now)
  return item
}

async function markTomorrowPriority(wordId: string, at = new Date()): Promise<void> {
  const state = await db.reviewState.get(wordId)
  if (!state) return
  const tomorrow = dayjs(at).add(1, 'day').startOf('day').toISOString()
  await db.reviewState.put({ ...state, nextReviewAt: tomorrow, sameDayRelearnAt: undefined })
  await markRecordChanged('reviewState', wordId)
}

async function pauseForScheduledArticle(sessionId: string, at: Date): Promise<boolean> {
  const [session, settings] = await Promise.all([db.dailyLearningSessions.get(sessionId), loadSettings()])
  if (!session || session.status === 'completed') return false
  const roundIndex = session.activeRoundIndex ?? 0
  if (!roundIndex || roundIndex % settings.articleEveryRounds !== 0 || session.lastArticleRoundIndex === roundIndex) return false
  const now = at.toISOString()
  const rounds = parseRounds(session.roundsJson)
  const groupStartRound = Math.floor((roundIndex - 1) / settings.articleEveryRounds) * settings.articleEveryRounds + 1
  let activeReadingBatchIndex = 0
  for (let start = 1; start < groupStartRound; start += settings.articleEveryRounds) {
    const wordCount = new Set(rounds
      .filter((round) => round.index >= start && round.index < start + settings.articleEveryRounds)
      .flatMap((round) => round.wordIds)).size
    activeReadingBatchIndex += Math.ceil(wordCount / 12)
  }
  const updated: DailyLearningSession = {
    ...session,
    phase: 'article',
    activeReadingBatchIndex,
    lastArticleRoundIndex: roundIndex,
    articleStatus: session.articleStatus === 'ready' || session.articleStatus === 'generating' ? session.articleStatus : 'waiting',
    sessionRevision: (session.sessionRevision ?? 0) + 1,
    updatedAt: now,
  }
  await db.dailyLearningSessions.put(updated)
  await markPayloadChanged('dailyLearningSessions', updated, now)
  return true
}

async function pauseForScheduledPractice(sessionId: string, at: Date): Promise<boolean> {
  const session = await db.dailyLearningSessions.get(sessionId)
  if (!session || session.status === 'completed') return false
  const roundIndex = session.activeRoundIndex ?? 0
  if (!roundIndex
    || session.pendingPracticeRoundIndex !== roundIndex
    || !session.pendingPracticeSessionId
    || session.lastPracticeRoundIndex === roundIndex) return false
  const updated = {
    ...session,
    phase: 'practice' as const,
    sessionRevision: (session.sessionRevision ?? 0) + 1,
    updatedAt: at.toISOString(),
  }
  await db.dailyLearningSessions.put(updated)
  await markPayloadChanged('dailyLearningSessions', updated, updated.updatedAt)
  return true
}

async function advanceToPlannedRound(sessionId: string, at: Date): Promise<boolean> {
  const session = await db.dailyLearningSessions.get(sessionId)
  if (!session || session.status === 'completed') return false
  const rounds = parseRounds(session.roundsJson)
  const currentIndex = session.activeRoundIndex ?? 0
  const next = rounds.find((round) => round.index > currentIndex && round.status === 'pending')
  if (!next) return false
  const now = at.toISOString()
  const updated: DailyLearningSession = {
    ...session,
    activeRoundIndex: next.index,
    roundsJson: JSON.stringify(rounds.map((round) => {
      if (round.index === currentIndex) return { ...round, status: 'completed' as const, completedAt: now }
      if (round.index === next.index) return { ...round, status: 'active' as const, startedAt: now }
      return round
    })),
    phase: 'cards',
    articleStatus: session.articleStatus === 'completed' || session.articleStatus === 'skipped' ? 'waiting' : session.articleStatus,
    sessionRevision: (session.sessionRevision ?? 0) + 1,
    updatedAt: now,
  }
  await db.dailyLearningSessions.put(updated)
  await markPayloadChanged('dailyLearningSessions', updated, now)
  return true
}

function nextCarryReadingBatchIndex(
  session: DailyLearningSession,
  units: LearningUnit[],
  activeIndex: number,
): number {
  const incompleteIntroducedWords = new Set(units
    .slice(0, activeIndex + 1)
    .filter((unit) => !unit.articleCompletedAt)
    .flatMap((unit) => unit.wordIds))
  if (!incompleteIntroducedWords.size) return -1
  return parseReadingBatchesJson(session.readingBatchesJson).findIndex((batch, index) =>
    index > (session.activeReadingBatchIndex ?? -1)
    && batch.some((wordId) => incompleteIntroducedWords.has(wordId)))
}

async function advanceLearningEngine(sessionId: string, at: Date): Promise<boolean> {
  const session = await db.dailyLearningSessions.get(sessionId)
  if (!session || session.engineVersion !== ENGINE_VERSION || session.status === 'completed') return false
  if (session.phase !== 'cards') return true

  const units = parseLearningUnits(session.unitsJson)
  const activeIndex = Math.max(0, Math.min(session.activeUnitIndex ?? 0, Math.max(0, units.length - 1)))
  const activeUnit = units[activeIndex]
  const items = await db.dailyQueueItems.where('sessionId').equals(sessionId).toArray()
  let pending = items.filter((item) => item.kind === 'card' && (item.status === 'pending' || item.status === 'active'))
  const now = at.toISOString()
  const bump = (patch: Partial<DailyLearningSession>): DailyLearningSession => ({
    ...session,
    ...patch,
    sessionRevision: (session.sessionRevision ?? 0) + 1,
    updatedAt: now,
  })

  if (!activeUnit) {
    const updated = bump({
      status: pending.length ? 'active' : 'completed',
      phase: pending.length ? 'cards' : 'summary',
      learningStage: pending.length ? 'retry' : undefined,
      completedAt: pending.length ? undefined : now,
    })
    await db.dailyLearningSessions.put(updated)
    await markPayloadChanged('dailyLearningSessions', updated, now)
    return true
  }

  const stage = session.learningStage ?? 'probe'
  if (stage === 'probe') {
    const hasProbe = pending.some((item) => item.unitId === activeUnit.unitId && item.stage === 'probe')
    if (hasProbe) return true
    const updatedUnits = units.map((unit, index) => index === activeIndex
      ? { ...unit, status: 'active' as const }
      : unit)
    const readingBatches = parseReadingBatchesJson(session.readingBatchesJson)
    if (activeUnit.articleCompletedAt) {
      const carryBatchIndex = nextCarryReadingBatchIndex(session, units, activeIndex)
      if (carryBatchIndex >= 0) {
        const updated = bump({
          phase: 'article',
          learningStage: 'read',
          activeReadingBatchIndex: carryBatchIndex,
          articleStatus: 'waiting',
          unitsJson: JSON.stringify(updatedUnits),
        })
        await db.dailyLearningSessions.put(updated)
        await markPayloadChanged('dailyLearningSessions', updated, now)
        return true
      }
      const updated = bump({
        phase: 'cards',
        learningStage: 'learn',
        unitsJson: JSON.stringify(updatedUnits),
      })
      await db.dailyLearningSessions.put(updated)
      await markPayloadChanged('dailyLearningSessions', updated, now)
      return true
    }
    const activeReadingBatchIndex = findReadingBatchForUnit(
      readingBatches,
      activeUnit.wordIds,
      activeIndex > 0 ? session.activeReadingBatchIndex ?? -1 : -1,
    )
    const updated = bump({
      phase: 'article',
      learningStage: 'read',
      activeReadingBatchIndex,
      articleStatus: 'waiting',
      unitsJson: JSON.stringify(updatedUnits),
    })
    await db.dailyLearningSessions.put(updated)
    await markPayloadChanged('dailyLearningSessions', updated, now)
    return true
  }

  if (stage === 'learn') {
    const hasLearningCards = pending.some((item) => item.unitId === activeUnit.unitId && item.stage === 'learn')
    if (hasLearningCards) return true
    const carryBatchIndex = nextCarryReadingBatchIndex(session, units, activeIndex)
    if (carryBatchIndex >= 0) {
      const updated = bump({
        phase: 'article',
        learningStage: 'read',
        activeReadingBatchIndex: carryBatchIndex,
        articleStatus: 'waiting',
      })
      await db.dailyLearningSessions.put(updated)
      await markPayloadChanged('dailyLearningSessions', updated, now)
      return true
    }
    if (session.pendingPracticeSessionId
      && session.pendingPracticeRoundIndex === (session.activeRoundIndex ?? activeIndex + 1)
      && session.lastPracticeRoundIndex !== session.pendingPracticeRoundIndex) {
      const updated = bump({ phase: 'practice', learningStage: 'transfer' })
      await db.dailyLearningSessions.put(updated)
      await markPayloadChanged('dailyLearningSessions', updated, now)
      return true
    }
  }

  const nextIndex = units.findIndex((unit, index) => index > activeIndex && unit.status !== 'completed')
  if (stage === 'retry' && pending.length) {
    const attempts = await db.dailyQueueAttempts.where('sessionId').equals(sessionId).sortBy('answeredAt')
    const selection = selectCurrentItem(session, items, attempts, at)
    if (selection.current) return true
    if (nextIndex < 0 && selection.waitingForActivities) {
      // No later learning unit can advance the activity clock. Keeping these
      // retries in-session would deadlock forever, so make tomorrow explicit.
      const activityOrdinal = session.activityOrdinal ?? 0
      const deferred = pending
        .filter((item) => item.stage === 'retry'
          && (item.eligibleAfterOrdinal ?? 0) > activityOrdinal)
        .map((item) => ({
          ...item,
          status: 'skipped' as const,
          memoryStatus: 'tomorrow' as const,
          tomorrowPriority: true,
          updatedAt: now,
        }))
      if (deferred.length) {
        await db.dailyQueueItems.bulkPut(deferred)
        for (const item of deferred) {
          if (item.wordId) await markTomorrowPriority(item.wordId, at)
          await markPayloadChanged('dailyQueueItems', item, now)
        }
        const deferredIds = new Set(deferred.map((item) => item.itemId))
        pending = pending.filter((item) => !deferredIds.has(item.itemId))
      }
    } else if (nextIndex < 0) {
      // The ordinal constraint is already satisfied; only the wall-clock delay
      // remains, so the view may safely wake at nextAvailableAt.
      return true
    }
    // A later unit exists: activate it so retries can earn real cross-unit
    // spacing instead of blocking the rolling pool on a timer.
  }

  if (nextIndex >= 0) {
    const updatedUnits = units.map((unit, index) => ({
      ...unit,
      status: index < nextIndex ? 'completed' as const
        : index === nextIndex ? 'active' as const : 'pending' as const,
    }))
    const updated = bump({
      phase: 'cards',
      learningStage: 'probe',
      activeUnitIndex: nextIndex,
      activeRoundIndex: nextIndex + 1,
      unitsJson: JSON.stringify(updatedUnits),
      articleStatus: 'waiting',
    })
    await db.dailyLearningSessions.put(updated)
    await markPayloadChanged('dailyLearningSessions', updated, now)
    return true
  }

  const retryPending = pending.some((item) => item.stage === 'retry')
  const updatedUnits = units.map((unit) => ({ ...unit, status: 'completed' as const }))
  const updated = bump({
    status: retryPending ? 'active' : 'completed',
    phase: retryPending ? 'cards' : 'summary',
    learningStage: retryPending ? 'retry' : undefined,
    unitsJson: JSON.stringify(updatedUnits),
    cardsCompletedAt: retryPending ? undefined : (session.cardsCompletedAt ?? now),
    completedAt: retryPending ? undefined : now,
  })
  await db.dailyLearningSessions.put(updated)
  await markPayloadChanged('dailyLearningSessions', updated, now)
  if (retryPending) await advanceLearningEngine(sessionId, at)
  return true
}

async function advanceSessionIfCardsDone(sessionId: string, at = new Date()): Promise<void> {
  const session = await db.dailyLearningSessions.get(sessionId)
  if (!session) return
  if (session.engineVersion === ENGINE_VERSION) {
    await advanceLearningEngine(sessionId, at)
    return
  }
  const activeRoundIndex = session.activeRoundIndex ?? 1
  const pendingInActiveRound = await db.dailyQueueItems
    .where('sessionId')
    .equals(sessionId)
    .filter((item) => item.kind === 'card' && (item.status === 'pending' || item.status === 'active') && (item.roundIndex ?? 1) === activeRoundIndex)
    .count()
  if (pendingInActiveRound > 0) return
  if (await pauseForScheduledPractice(sessionId, at)) return
  if (await pauseForScheduledArticle(sessionId, at)) return
  if (await advanceToPlannedRound(sessionId, at)) return
  const pending = await db.dailyQueueItems
    .where('sessionId')
    .equals(sessionId)
    .filter((item) => item.kind === 'card' && (item.status === 'pending' || item.status === 'active'))
    .count()
  if (pending > 0) return
  const now = new Date().toISOString()
  const updated: DailyLearningSession = {
    ...session,
    cardsCompletedAt: session.cardsCompletedAt ?? now,
    updatedAt: now,
  }
  await db.dailyLearningSessions.put(updated)
  await markPayloadChanged('dailyLearningSessions', updated, now)
}

export async function resumeDailyCardsAfterPractice(sessionId: string, at = new Date()): Promise<DailyQueueSnapshot> {
  const session = await db.dailyLearningSessions.get(sessionId)
  if (!session) throw new Error('今日学习会话不存在')
  const roundIndex = session.pendingPracticeRoundIndex ?? session.activeRoundIndex
  const now = at.toISOString()
  const updated: DailyLearningSession = {
    ...session,
    phase: 'cards',
    activityOrdinal: (session.activityOrdinal ?? 0) + 1,
    sessionRevision: (session.sessionRevision ?? 0) + 1,
    pendingPracticeRoundIndex: undefined,
    pendingPracticeSessionId: undefined,
    lastPracticeRoundIndex: roundIndex,
    updatedAt: now,
  }
  await db.dailyLearningSessions.put(updated)
  await markPayloadChanged('dailyLearningSessions', updated, now)
  await advanceSessionIfCardsDone(sessionId, at)
  return loadDailyQueueSnapshot(sessionId, at)
}

/** Resume cards after an interleaved article, starting a fresh dynamic round when needed. */
export async function resumeDailyCardsAfterArticle(sessionId: string, at = new Date()): Promise<DailyQueueSnapshot> {
  const session = await db.dailyLearningSessions.get(sessionId)
  if (!session) throw new Error('今日学习会话不存在')
  const now = at.toISOString()
  if (session.engineVersion === ENGINE_VERSION) {
    const plannedBatch = parseReadingBatchesJson(session.readingBatchesJson)[session.activeReadingBatchIndex ?? 0] ?? []
    const handledWordIds = new Set<string>()
    const completedReading = await db.readingSessions
      .where('dayKey')
      .equals(session.dayKey)
      .filter((reading) => reading.selectionSeed === 0 && reading.status === 'completed')
      .toArray()
    completedReading.forEach((reading) => {
      const coveredWordIds = [...reading.targetWordIds, ...(reading.unquizzedTargetWordIds ?? [])]
      coveredWordIds.forEach((wordId) => handledWordIds.add(wordId))
      try {
        const segments = JSON.parse(reading.segmentsJson) as Array<{ wordId?: unknown }>
        segments.forEach((segment) => {
          if (typeof segment.wordId === 'string') handledWordIds.add(segment.wordId)
        })
      } catch {
        // Older damaged segment payloads still retain targetWordIds above.
      }
    })
    if (session.articleStatus === 'skipped') plannedBatch.forEach((wordId) => handledWordIds.add(wordId))
    const units = parseLearningUnits(session.unitsJson).map((unit) => (
      unit.wordIds.length > 0 && unit.wordIds.every((wordId) => handledWordIds.has(wordId))
        ? { ...unit, articleCompletedAt: unit.articleCompletedAt ?? now }
        : unit
    ))
    const resumed: DailyLearningSession = {
      ...session,
      phase: 'cards',
      status: 'active',
      learningStage: 'learn',
      activityOrdinal: (session.activityOrdinal ?? 0) + 1,
      unitsJson: JSON.stringify(units),
      sessionRevision: (session.sessionRevision ?? 0) + 1,
      updatedAt: now,
    }
    await db.dailyLearningSessions.put(resumed)
    await markPayloadChanged('dailyLearningSessions', resumed, now)
    await advanceLearningEngine(sessionId, at)
    return loadDailyQueueSnapshot(sessionId, at)
  }
  const resumed: DailyLearningSession = {
    ...session,
    phase: 'cards',
    status: 'active',
    sessionRevision: (session.sessionRevision ?? 0) + 1,
    updatedAt: now,
  }
  await db.dailyLearningSessions.put(resumed)
  await markPayloadChanged('dailyLearningSessions', resumed, now)
  if (await advanceToPlannedRound(sessionId, at)) return loadDailyQueueSnapshot(sessionId)
  const pendingItems = await db.dailyQueueItems.where('sessionId').equals(sessionId)
    .filter((item) => item.kind === 'card' && (item.status === 'pending' || item.status === 'active'))
    .toArray()
  if (pendingItems.length) {
    const nextRoundIndex = Math.min(...pendingItems.map((item) => item.roundIndex ?? 1))
    const rounds = parseRounds(resumed.roundsJson).map((round) => ({
      ...round,
      status: round.index < nextRoundIndex ? 'completed' as const
        : round.index === nextRoundIndex ? 'active' as const : 'pending' as const,
      startedAt: round.index === nextRoundIndex ? (round.startedAt || now) : round.startedAt,
    }))
    const recovered = {
      ...resumed,
      activeRoundIndex: nextRoundIndex,
      roundsJson: JSON.stringify(rounds),
      sessionRevision: (resumed.sessionRevision ?? 0) + 1,
      updatedAt: now,
    }
    await db.dailyLearningSessions.put(recovered)
    await markPayloadChanged('dailyLearningSessions', recovered, now)
    return loadDailyQueueSnapshot(sessionId)
  }
  const completed: DailyLearningSession = {
    ...resumed,
    phase: 'summary',
    status: 'completed',
    completedAt: now,
    sessionRevision: (resumed.sessionRevision ?? 0) + 1,
    updatedAt: now,
  }
  await db.dailyLearningSessions.put(completed)
  await markPayloadChanged('dailyLearningSessions', completed, now)
  return loadDailyQueueSnapshot(sessionId)
}

export async function recordLearningActivity(sessionId: string, at = new Date()): Promise<void> {
  const session = await db.dailyLearningSessions.get(sessionId)
  if (!session || session.status !== 'active') return
  const updated: DailyLearningSession = {
    ...session,
    activityOrdinal: (session.activityOrdinal ?? 0) + 1,
    sessionRevision: (session.sessionRevision ?? 0) + 1,
    updatedAt: at.toISOString(),
  }
  await db.dailyLearningSessions.put(updated)
  await markPayloadChanged('dailyLearningSessions', updated, updated.updatedAt)
}

/**
 * Atomically persists a context answer, advances the activity clock, and
 * schedules at most one retry for the word. Replaying the same attemptId is a
 * no-op, which makes browser retries and concurrent tabs safe.
 */
export async function recordContextLearningEvidence(
  attempt: ContextAttempt,
  dailySessionId?: string,
): Promise<ContextAttempt> {
  let persisted = attempt
  const stores = dailySessionId
    ? [
        db.contextAttempts,
        db.dailyLearningSessions,
        db.dailyQueueItems,
        db.dailyQueueAttempts,
        db.reviewState,
        db.syncMeta,
        db.syncRecords,
        db.syncTombstones,
      ]
    : [db.contextAttempts, db.syncMeta, db.syncRecords, db.syncTombstones]
  await db.transaction('rw', stores, async () => {
    const existingAttempt = await db.contextAttempts.get(attempt.attemptId)
    if (existingAttempt) {
      persisted = existingAttempt
      return
    }
    if (!dailySessionId) {
      await db.contextAttempts.put(attempt)
      await markPayloadChanged('contextAttempts', attempt, attempt.answeredAt)
      return
    }

    const session = await db.dailyLearningSessions.get(dailySessionId)
    if (!session || session.status !== 'active') throw new Error('今日学习会话已结束')
    const activityOrdinal = (session.activityOrdinal ?? 0) + 1
    await db.contextAttempts.put(attempt)
    await markPayloadChanged('contextAttempts', attempt, attempt.answeredAt)

    if (attempt.result !== 'correct') {
      const [queueAttempts, activeRetry, allItems] = await Promise.all([
        db.dailyQueueAttempts.where('[sessionId+wordId]').equals([dailySessionId, attempt.wordId]).toArray(),
        db.dailyQueueItems.where('sessionId').equals(dailySessionId)
          .filter((item) => item.wordId === attempt.wordId
            && item.stage === 'retry'
            && (item.status === 'pending' || item.status === 'active'))
          .first(),
        db.dailyQueueItems.where('sessionId').equals(dailySessionId).toArray(),
      ])
      if (!activeRetry && queueAttempts.length < MAX_DAILY_ATTEMPTS) {
        const existingRetry = await db.dailyQueueItems.get(`${dailySessionId}:context:${attempt.wordId}`)
        const units = parseLearningUnits(session.unitsJson)
        const item: DailyQueueItem = {
          ...(existingRetry ?? {
            itemId: `${dailySessionId}:context:${attempt.wordId}`,
            sessionId: dailySessionId,
            kind: 'card' as const,
            wordId: attempt.wordId,
            createdAt: attempt.answeredAt,
          }),
          reason: 'context-retry',
          roundIndex: session.activeRoundIndex ?? 1,
          unitId: units[session.activeUnitIndex ?? 0]?.unitId,
          stage: 'retry',
          eligibleAfterOrdinal: activityOrdinal + AGAIN_MIN_ACTIVITY_GAP,
          notBeforeAt: new Date(Date.parse(attempt.answeredAt) + AGAIN_DELAY_MS).toISOString(),
          canonicalGradeCommitted: queueAttempts.some((row) => row.committedToFsrs),
          memoryStatus: 'retry-later',
          position: Math.max(-1, ...allItems.map((item) => item.position)) + 1,
          status: 'pending',
          attemptNo: queueAttempts.length + 1,
          maxAttempts: MAX_DAILY_ATTEMPTS,
          retrievability: 0,
          startingLongTermRetrievability: 0,
          todayMastery: 40,
          recallStreak: 0,
          weakSeen: true,
          attemptCount: queueAttempts.length,
          nextGap: AGAIN_MIN_ACTIVITY_GAP,
          tomorrowPriority: false,
          updatedAt: attempt.answeredAt,
        }
        await db.dailyQueueItems.put(item)
        await markPayloadChanged('dailyQueueItems', item, attempt.answeredAt)
      } else if (!activeRetry && queueAttempts.length >= MAX_DAILY_ATTEMPTS) {
        await markTomorrowPriority(attempt.wordId, new Date(attempt.answeredAt))
      }
    }

    const updatedSession: DailyLearningSession = {
      ...session,
      activityOrdinal,
      sessionRevision: (session.sessionRevision ?? 0) + 1,
      updatedAt: attempt.answeredAt,
    }
    await db.dailyLearningSessions.put(updatedSession)
    await markPayloadChanged('dailyLearningSessions', updatedSession, attempt.answeredAt)
  })
  return persisted
}

export async function finishCardPhase(sessionId: string): Promise<DailyQueueSnapshot> {
  const pending = await db.dailyQueueItems.where('sessionId').equals(sessionId)
    .filter((item) => item.kind === 'card' && (item.status === 'pending' || item.status === 'active'))
    .count()
  if (pending) throw new Error('当前队列还有未完成的单词')
  const session = await db.dailyLearningSessions.get(sessionId)
  if (!session) throw new Error('今日学习会话不存在')
  const now = new Date().toISOString()
  const alreadyFinishedArticle = session.articleStatus === 'completed' || session.articleStatus === 'skipped'
  const updated: DailyLearningSession = {
    ...session,
    phase: alreadyFinishedArticle ? 'summary' : 'article',
    status: alreadyFinishedArticle ? 'completed' : 'active',
    cardsCompletedAt: session.cardsCompletedAt ?? now,
    completedAt: alreadyFinishedArticle ? now : undefined,
    sessionRevision: (session.sessionRevision ?? 0) + 1,
    updatedAt: now,
  }
  await db.dailyLearningSessions.put(updated)
  await markPayloadChanged('dailyLearningSessions', updated, now)
  return loadDailyQueueSnapshot(sessionId)
}

async function applyRecoveryCalibration(sessionId: string, at: Date): Promise<void> {
  const session = await db.dailyLearningSessions.get(sessionId)
  if (!session?.recoveryMode
    || session.recoveryNewWordsAdded
    || (session.recoveryCalibrationCount ?? 0) < 15) return
  const accuracy = session.recoveryAccuracy ?? 0
  const scale: 0 | 0.5 | 1 = accuracy < 0.6 ? 0 : accuracy < 0.8 ? 0.5 : 1
  const settings = await loadSettings()
  const desiredNewWords = Math.floor(settings.dailyNewLimit * scale)
  const plan = desiredNewWords
    ? await buildTodayPlan({
        at,
        listIds: session.selectedListIds.length ? session.selectedListIds : undefined,
        excludeWordIds: session.initialWordIds,
        dailyReviewLimit: 0,
        dailyNewLimit: desiredNewWords,
        promoteImportBacklog: true,
        allowRecoveryNewWords: true,
      })
    : undefined
  const now = at.toISOString()
  const content = plan?.queueWordIds.length
    ? await createV2AppendedContent(session, plan.queueWordIds, 'extra-batch', at, settings.roundWordCount)
    : undefined
  const updated: DailyLearningSession = {
    ...session,
    recoveryNewWordsAdded: true,
    recoveryNewWordScale: scale,
    initialWordIds: content ? [...session.initialWordIds, ...content.orderedWordIds] : session.initialWordIds,
    unitsJson: content ? JSON.stringify(content.units) : session.unitsJson,
    roundsJson: content ? roundsFromUnits(content.units, now) : session.roundsJson,
    sessionRevision: (session.sessionRevision ?? 0) + 1,
    updatedAt: now,
  }
  await db.transaction('rw', [
    db.dailyLearningSessions,
    db.dailyQueueItems,
    db.syncMeta,
    db.syncRecords,
    db.syncTombstones,
  ], async () => {
    if (content?.items.length) await db.dailyQueueItems.bulkPut(content.items)
    await db.dailyLearningSessions.put(updated)
    for (const item of content?.items ?? []) await markPayloadChanged('dailyQueueItems', item, now)
    await markPayloadChanged('dailyLearningSessions', updated, now)
  })
}

export async function answerDailyCard(
  sessionId: string,
  itemId: string,
  rating: ReviewRating,
  at = new Date(),
  evidence: {
    expectedSessionRevision?: number
    responseMs?: number
    hintLevel?: number
    evidenceKind?: LearningEvidenceKind
    skill?: LearningSkill
  } = {},
): Promise<DailyQueueSnapshot> {
  await db.transaction('rw', [
    db.dailyLearningSessions,
    db.dailyQueueItems,
    db.dailyQueueAttempts,
    db.reviewState,
    db.reviewLogs,
    db.syncMeta,
    db.syncRecords,
    db.syncTombstones,
  ], async () => {
    const [session, item] = await Promise.all([
      db.dailyLearningSessions.get(sessionId),
      db.dailyQueueItems.get(itemId),
    ])
    if (!session) throw new Error('今日学习会话不存在')
    if (evidence.expectedSessionRevision !== undefined
      && evidence.expectedSessionRevision !== (session.sessionRevision ?? 0)) {
      throw new Error('学习队列已在其他页面更新，请按最新卡片作答')
    }
    if (!item?.wordId || item.sessionId !== sessionId || item.kind !== 'card') throw new Error('队列卡片不存在')
    if (item.status === 'completed' || item.status === 'skipped') throw new Error('这次活动已经提交')

    const previousAttempts = await db.dailyQueueAttempts
      .where('[sessionId+wordId]')
      .equals([sessionId, item.wordId])
      .toArray()
    const masteryBefore = item.todayMastery ?? 0
    const outcome = computeShortTermReview({
      mastery: masteryBefore,
      recallStreak: item.recallStreak,
      weakSeen: item.weakSeen,
      wasNew: item.wasNew,
      startingLongTermRetrievability: item.startingLongTermRetrievability,
    }, rating)
    const alreadyCommitted = previousAttempts.some((row) => row.committedToFsrs)
      || item.canonicalGradeCommitted === true
    const commitsCanonicalGrade = !alreadyCommitted
    const activityOrdinal = (session.activityOrdinal ?? previousAttempts.length) + 1
    const failureCount = previousAttempts.filter((row) => row.rating === 'again' || row.rating === 'hard').length
      + (rating === 'again' || rating === 'hard' ? 1 : 0)
    const deferToTomorrow = !outcome.passed && failureCount >= MAX_DAILY_ATTEMPTS

    if (commitsCanonicalGrade) {
      const prepared = await prepareCardGrade(item.wordId, rating, at, {
        attemptCount: 1,
        ratings: [rating],
        masteryBefore,
        masteryAfter: outcome.mastery,
      })
      await persistPreparedCardGrade(prepared)
    }

    const attempt: DailyQueueAttempt = {
      attemptId: `${itemId}:answer`,
      sessionId,
      itemId,
      wordId: item.wordId,
      rating,
      committedToFsrs: commitsCanonicalGrade,
      masteryBefore,
      masteryAfter: outcome.mastery,
      reinsertionGap: outcome.passed || deferToTomorrow ? 0 : outcome.reinsertionGap,
      effectiveFsrsRating: commitsCanonicalGrade ? rating : undefined,
      activityOrdinal,
      evidenceKind: evidence.evidenceKind ?? 'unprompted-card',
      skill: evidence.skill ?? 'meaning-recall',
      responseMs: evidence.responseMs,
      hintLevel: evidence.hintLevel ?? (item.stage === 'retry' && failureCount >= 2 ? 2 : 0),
      answeredAt: at.toISOString(),
    }
    const completed: DailyQueueItem = {
      ...item,
      status: 'completed',
      todayMastery: outcome.mastery,
      recallStreak: outcome.recallStreak,
      weakSeen: outcome.weakSeen,
      canonicalGradeCommitted: alreadyCommitted || commitsCanonicalGrade,
      memoryStatus: outcome.passed ? 'passed' : deferToTomorrow ? 'tomorrow' : 'retry-later',
      tomorrowPriority: deferToTomorrow,
      updatedAt: attempt.answeredAt,
    }
    await db.dailyQueueItems.put(completed)
    await db.dailyQueueAttempts.put(attempt)
    await markPayloadChanged('dailyQueueItems', completed, attempt.answeredAt)
    await markPayloadChanged('dailyQueueAttempts', attempt, attempt.answeredAt)

    if (!outcome.passed && !deferToTomorrow) {
      const repeatReason: DailyQueueReason = rating === 'again' ? 'again-repeat' : 'hard-repeat'
      await insertRepeat(completed, repeatReason, rating, failureCount, activityOrdinal, at, outcome)
    } else if (deferToTomorrow) {
      await markTomorrowPriority(item.wordId, at)
    }

    const countsTowardCalibration = Boolean(
      session.recoveryMode
      && commitsCanonicalGrade
      && (session.recoveryCalibrationCount ?? 0) < 15,
    )
    const calibrationCount = (session.recoveryCalibrationCount ?? 0) + (countsTowardCalibration ? 1 : 0)
    const calibrationCorrect = (session.recoveryCalibrationCorrect ?? 0)
      + (countsTowardCalibration && (rating === 'good' || rating === 'easy') ? 1 : 0)
    const updatedSession: DailyLearningSession = {
      ...session,
      activityOrdinal,
      sessionRevision: (session.sessionRevision ?? 0) + 1,
      recoveryCalibrationCount: session.recoveryMode ? calibrationCount : session.recoveryCalibrationCount,
      recoveryCalibrationCorrect: session.recoveryMode ? calibrationCorrect : session.recoveryCalibrationCorrect,
      recoveryAccuracy: session.recoveryMode && calibrationCount
        ? calibrationCorrect / calibrationCount
        : session.recoveryAccuracy,
      updatedAt: attempt.answeredAt,
    }
    await db.dailyLearningSessions.put(updatedSession)
    await markPayloadChanged('dailyLearningSessions', updatedSession, attempt.answeredAt)
  })
  await applyRecoveryCalibration(sessionId, at)
  await advanceSessionIfCardsDone(sessionId, at)
  return loadDailyQueueSnapshot(sessionId, at)
}

export interface AnswerLearningActivityInput {
  sessionId: string
  itemId: string
  rating: ReviewRating
  answeredAt?: Date
  expectedSessionRevision?: number
  responseMs?: number
  hintLevel?: number
  evidenceKind?: LearningEvidenceKind
  skill?: LearningSkill
}

/** Public command surface for every scored learning activity. */
export async function answerLearningActivity(input: AnswerLearningActivityInput): Promise<DailyQueueSnapshot> {
  return answerDailyCard(
    input.sessionId,
    input.itemId,
    input.rating,
    input.answeredAt ?? new Date(),
    {
      responseMs: input.responseMs,
      expectedSessionRevision: input.expectedSessionRevision,
      hintLevel: input.hintLevel,
      evidenceKind: input.evidenceKind,
      skill: input.skill,
    },
  )
}

export async function enqueueContextRetry(sessionId: string, wordId: string): Promise<void> {
  const [attempts, existing, session] = await Promise.all([
    db.dailyQueueAttempts.where('[sessionId+wordId]').equals([sessionId, wordId]).toArray(),
    db.dailyQueueItems.where('sessionId').equals(sessionId)
      .filter((item) => item.wordId === wordId
        && item.stage === 'retry'
        && (item.status === 'pending' || item.status === 'active'))
      .first(),
    db.dailyLearningSessions.get(sessionId),
  ])
  if (existing || !session) return
  if (attempts.length >= MAX_DAILY_ATTEMPTS) {
    await markTomorrowPriority(wordId)
    return
  }
  const now = new Date().toISOString()
  const last = await db.dailyQueueItems.where('sessionId').equals(sessionId).last()
  const rounds = parseRounds(session?.roundsJson)
  const nextRoundIndex = Math.max(session?.activeRoundIndex ?? 0, ...rounds.map((round) => round.index), 0) + 1
  const item: DailyQueueItem = {
    itemId: `${sessionId}:context:${wordId}:${crypto.randomUUID()}`,
    sessionId,
    kind: 'card',
    wordId,
    reason: 'context-retry',
    roundIndex: session.activeRoundIndex ?? nextRoundIndex,
    unitId: parseLearningUnits(session.unitsJson)[session.activeUnitIndex ?? 0]?.unitId,
    stage: 'retry',
    eligibleAfterOrdinal: (session.activityOrdinal ?? attempts.length) + AGAIN_MIN_ACTIVITY_GAP,
    notBeforeAt: new Date(Date.now() + AGAIN_DELAY_MS).toISOString(),
    canonicalGradeCommitted: attempts.some((attempt) => attempt.committedToFsrs),
    memoryStatus: 'retry-later',
    position: (last?.position ?? -1) + 1,
    status: 'pending',
    attemptNo: attempts.length + 1,
    maxAttempts: MAX_DAILY_ATTEMPTS,
    retrievability: 0,
    startingLongTermRetrievability: 0,
    todayMastery: 40,
    recallStreak: 0,
    weakSeen: true,
    attemptCount: attempts.length,
    nextGap: 0,
    tomorrowPriority: false,
    createdAt: now,
    updatedAt: now,
  }
  await db.dailyQueueItems.put(item)
  if (session.engineVersion !== ENGINE_VERSION) {
    const updatedRounds = [...rounds, {
      index: nextRoundIndex,
      wordIds: [wordId],
      status: 'pending' as const,
      startedAt: '',
    }]
    const updated = {
      ...session,
      roundsJson: JSON.stringify(updatedRounds),
      sessionRevision: (session.sessionRevision ?? 0) + 1,
      updatedAt: now,
    }
    await db.dailyLearningSessions.put(updated)
    await markPayloadChanged('dailyLearningSessions', updated, now)
  } else {
    const updated = {
      ...session,
      sessionRevision: (session.sessionRevision ?? 0) + 1,
      updatedAt: now,
    }
    await db.dailyLearningSessions.put(updated)
    await markPayloadChanged('dailyLearningSessions', updated, now)
  }
  await markPayloadChanged('dailyQueueItems', item, now)
}

export async function skipWordInDailySession(sessionId: string, wordId: string): Promise<void> {
  const now = new Date().toISOString()
  const rows = await db.dailyQueueItems.where('sessionId').equals(sessionId).filter((item) => item.wordId === wordId && (item.status === 'pending' || item.status === 'active')).toArray()
  if (rows.length) {
    const updates = rows.map((row) => ({ ...row, status: 'skipped' as const, updatedAt: now }))
    await db.dailyQueueItems.bulkPut(updates)
    for (const row of updates) await markPayloadChanged('dailyQueueItems', row, now)
  }
  await advanceSessionIfCardsDone(sessionId)
}

export async function setArticleStatus(
  sessionId: string,
  articleStatus: DailyLearningSession['articleStatus'],
): Promise<void> {
  const session = await db.dailyLearningSessions.get(sessionId)
  if (!session) return
  const now = new Date().toISOString()
  const resolvedStatus = articleStatus === 'ready'
    && session.articleGenerationWordCount !== undefined
    && session.articleGenerationWordCount !== session.initialWordIds.length
    ? 'stale'
    : articleStatus
  const updated = {
    ...session,
    articleStatus: resolvedStatus,
    articleGenerationWordCount: articleStatus === 'generating' ? session.initialWordIds.length : session.articleGenerationWordCount,
    sessionRevision: (session.sessionRevision ?? 0) + 1,
    updatedAt: now,
  }
  await db.dailyLearningSessions.put(updated)
  await markPayloadChanged('dailyLearningSessions', updated, now)
}

export async function completeDailySession(sessionId: string, articleStatus: 'completed' | 'skipped'): Promise<void> {
  const session = await db.dailyLearningSessions.get(sessionId)
  if (!session) return
  const now = new Date().toISOString()
  const updated: DailyLearningSession = {
    ...session,
    status: 'completed',
    phase: 'summary',
    articleStatus,
    completedAt: now,
    sessionRevision: (session.sessionRevision ?? 0) + 1,
    updatedAt: now,
  }
  await db.dailyLearningSessions.put(updated)
  await markPayloadChanged('dailyLearningSessions', updated, now)
}
