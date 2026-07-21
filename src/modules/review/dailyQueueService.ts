import dayjs from 'dayjs'
import { db } from '../../db/database'
import type {
  DailyLearningSession,
  DailyQueueAttempt,
  DailyQueueItem,
  DailyQueueReason,
  ReviewRating,
  ReviewState,
} from '../../types/models'
import { markPayloadChanged, markRecordChanged } from '../sync/localSyncStore'
import { buildAdditionalStudyWordIds, buildTodayPlan, gradeCard, listEligibleStudyWordIds } from './reviewService'
import { getReviewRetrievability } from './scheduler'
import { getStudyQueueRevision } from './studyDataRevision'
import { repairVocabularyIntegrity } from '../wordbook/vocabularyIntegrity'
import { loadSettings } from '../settings/settingsService'

const MAX_DAILY_ATTEMPTS = 5
export const DAILY_ROUND_SIZE = 5

type DailyRound = {
  index: number
  wordIds: string[]
  status: 'active' | 'completed'
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
  const previousStreak = input.recallStreak ?? 0
  const weakSeen = Boolean(input.weakSeen || rating === 'again' || rating === 'hard')
  const recallStreak = rating === 'good' ? previousStreak + 1 : 0
  const isMatureCleanRecall = !input.wasNew
    && !weakSeen
    && (input.startingLongTermRetrievability ?? 0) >= 0.75
  const requiredRecallStreak = isMatureCleanRecall ? 1 : 2

  let mastery: number
  if (rating === 'again') mastery = 0
  else if (rating === 'hard') mastery = Math.max(25, Math.min(45, Math.round(masteryBefore * 0.5)))
  else if (recallStreak >= requiredRecallStreak) mastery = 100
  else mastery = Math.max(65, Math.min(85, masteryBefore + 35))

  const passed = rating === 'good' && mastery === 100 && recallStreak >= requiredRecallStreak
  return {
    mastery,
    recallStreak,
    weakSeen,
    passed,
    reinsertionGap: passed ? 0 : masteryReinsertionGap(mastery),
    requiredRecallStreak,
  }
}

export function aggregateSessionRating(ratings: ReviewRating[]): ReviewRating {
  if (ratings.includes('again')) return 'again'
  if (ratings.includes('hard')) return 'hard'
  return 'good'
}

function createInitialQueueItems(
  session: DailyLearningSession,
  wordIds: string[],
  states: Array<ReviewState | undefined>,
  at: Date,
  roundIndex = session.activeRoundIndex ?? 1,
): DailyQueueItem[] {
  const now = at.toISOString()
  return wordIds.map((wordId, index) => {
    const state = states[index]
    const retrievability = state ? getReviewRetrievability(state, at) : 0
    const isNew = (state?.reps ?? state?.totalReviews ?? 0) === 0
    return {
      itemId: `${session.sessionId}:card:${index}`,
      sessionId: session.sessionId,
      kind: 'card',
      wordId,
      reason: 'initial',
      roundIndex,
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
  // A round is immutable once it starts. New words are deliberately not
  // appended here; `startNextRound` re-plans at the next round boundary.
  // This makes lookup additions eligible without disrupting the current recall.
  void settings
  const addedWordIds: string[] = []
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
  const updated = { ...session, dismissedSourceRevision: revision, updatedAt: new Date().toISOString() }
  await db.dailyLearningSessions.put(updated)
  await markPayloadChanged('dailyLearningSessions', updated, updated.updatedAt)
}

async function orderedItems(sessionId: string): Promise<DailyQueueItem[]> {
  return db.dailyQueueItems.where('sessionId').equals(sessionId).sortBy('position')
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
        status: row.status === 'completed' ? 'completed' : 'active',
        startedAt: typeof row.startedAt === 'string' ? row.startedAt : '',
        completedAt: typeof row.completedAt === 'string' ? row.completedAt : undefined,
      }]
    })
  } catch { return [] }
}

async function nextRoundWordIds(session: DailyLearningSession, at: Date): Promise<string[]> {
  const [items, settings] = await Promise.all([
    db.dailyQueueItems.where('sessionId').equals(session.sessionId).toArray(),
    loadSettings(),
  ])
  const started = new Map<string, boolean>()
  for (const item of items) {
    // Replanned legacy cards are retained for history as `skipped`; they must
    // not consume today's new/review quota when the next live round is built.
    if (item.kind !== 'card' || !item.wordId || item.reason !== 'initial' || item.status === 'skipped') continue
    if (!started.has(item.wordId)) started.set(item.wordId, Boolean(item.wasNew))
  }
  const startedNew = [...started.values()].filter(Boolean).length
  const startedReview = started.size - startedNew
  const plan = await buildTodayPlan({
    at,
    listIds: session.selectedListIds.length ? session.selectedListIds : undefined,
    excludeWordIds: [...started.keys()],
    dailyNewLimit: Math.max(0, Math.floor(settings.dailyNewLimit) - startedNew),
    dailyReviewLimit: Math.max(0, Math.floor(settings.dailyReviewLimit) - startedReview),
    promoteImportBacklog: true,
  })
  return plan.queueWordIds.slice(0, DAILY_ROUND_SIZE)
}

async function startNextRound(sessionId: string, at = new Date()): Promise<boolean> {
  const session = await db.dailyLearningSessions.get(sessionId)
  if (!session || session.status === 'completed') return false
  const wordIds = await nextRoundWordIds(session, at)
  if (!wordIds.length) return false
  const previousRoundIndex = session.activeRoundIndex ?? parseRounds(session.roundsJson).length
  const roundIndex = previousRoundIndex + 1
  const [states, existingItems] = await Promise.all([
    db.reviewState.bulkGet(wordIds),
    orderedItems(sessionId),
  ])
  const now = at.toISOString()
  const items = createInitialQueueItems(session, wordIds, states, at, roundIndex).map((item, index) => ({
    ...item,
    itemId: `${sessionId}:round:${roundIndex}:card:${index}`,
    position: existingItems.reduce((max, row) => Math.max(max, row.position), -1) + 1 + index,
  }))
  const rounds = parseRounds(session.roundsJson).map((round) => round.status === 'active'
    ? { ...round, status: 'completed' as const, completedAt: now }
    : round)
  rounds.push({ index: roundIndex, wordIds, status: 'active', startedAt: now })
  const updated: DailyLearningSession = {
    ...session,
    activeRoundIndex: roundIndex,
    roundsJson: JSON.stringify(rounds),
    initialWordIds: [...new Set([...session.initialWordIds, ...wordIds])],
    phase: 'cards',
    cardsCompletedAt: undefined,
    articleStatus: session.articleStatus === 'completed' || session.articleStatus === 'skipped' ? 'waiting' : session.articleStatus,
    updatedAt: now,
  }
  await db.transaction('rw', [db.dailyLearningSessions, db.dailyQueueItems], async () => {
    await db.dailyQueueItems.bulkPut(items)
    await db.dailyLearningSessions.put(updated)
  })
  for (const item of items) await markPayloadChanged('dailyQueueItems', item, now)
  await markPayloadChanged('dailyLearningSessions', updated, now)
  return true
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
  const refreshedWordIds = plan.queueWordIds.slice(0, DAILY_ROUND_SIZE)
  const now = at.toISOString()
  const skipped = items
    .filter((item) => (item.status === 'pending' || item.status === 'active') && (!item.wordId || !lockedWordIds.has(item.wordId)))
    .map((item) => ({ ...item, status: 'skipped' as const, updatedAt: now }))

  let freshItems: DailyQueueItem[] = []
  let updatedRounds = parseRounds(session.roundsJson)
  let nextActiveRoundIndex = activeRoundIndex
  if (!hasStarted && refreshedWordIds.length) {
    const states = await db.reviewState.bulkGet(refreshedWordIds)
    freshItems = createInitialQueueItems(session, refreshedWordIds, states, at, 1).map((item, index) => ({
      ...item,
      itemId: `${sessionId}:refresh:${crypto.randomUUID()}:${index}`,
      position: items.reduce((max, row) => Math.max(max, row.position), -1) + 1 + index,
    }))
    nextActiveRoundIndex = 1
    updatedRounds = [{ index: 1, wordIds: refreshedWordIds, status: 'active', startedAt: now }]
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
    initialWordIds: hasStarted ? retainedWordIds : refreshedWordIds,
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
  }))
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
  const addedItems = await createAppendedItems(session, preview.addedWordIds, 'list-change', at)
  const addedSet = new Set(preview.addedWordIds)
  const membershipsToActivate = (await db.studyListItems.toArray())
    .filter((membership) => addedSet.has(membership.wordId) && membership.autoActivate === 1)
    .map((membership) => ({ ...membership, learningEnabled: 1 as const, autoActivate: 0 as const }))
  const updated: DailyLearningSession = {
    ...session,
    status: addedItems.length ? 'active' : session.status,
    phase: addedItems.length ? 'cards' : session.phase,
    initialWordIds: [...session.initialWordIds.filter((wordId) => !removedSet.has(wordId)), ...preview.addedWordIds]
      .filter((wordId, index, rows) => rows.indexOf(wordId) === index),
    sourceRevision: preview.revision,
    sourceEligibleWordIds: preview.eligibleWordIds,
    dismissedSourceRevision: undefined,
    cardsCompletedAt: addedItems.length ? undefined : session.cardsCompletedAt,
    articleStatus: addedItems.length ? articleStatusAfterExtension(session.articleStatus) : session.articleStatus,
    readingBatchesJson: addedItems.length ? undefined : session.readingBatchesJson,
    activeReadingBatchIndex: addedItems.length ? undefined : session.activeReadingBatchIndex,
    completedAt: addedItems.length ? undefined : session.completedAt,
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
  await advanceSessionIfCardsDone(sessionId)
  return loadDailyQueueSnapshot(sessionId)
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
  const now = at.toISOString()
  const items = await createAppendedItems(session, wordIds, 'extra-batch', at)
  const updated: DailyLearningSession = {
    ...session,
    status: 'active',
    phase: 'cards',
    initialWordIds: [...session.initialWordIds, ...wordIds],
    extensionBatchCount: (session.extensionBatchCount ?? 0) + 1,
    cardsCompletedAt: undefined,
    articleStatus: articleStatusAfterExtension(session.articleStatus),
    readingBatchesJson: undefined,
    activeReadingBatchIndex: undefined,
    completedAt: undefined,
    updatedAt: now,
  }
  await db.transaction('rw', [db.dailyLearningSessions, db.dailyQueueItems], async () => {
    await db.dailyQueueItems.bulkPut(items)
    await db.dailyLearningSessions.put(updated)
  })
  for (const item of items) await markPayloadChanged('dailyQueueItems', item, now)
  await markPayloadChanged('dailyLearningSessions', updated, now)
  return loadDailyQueueSnapshot(sessionId)
}

export async function loadDailyQueueSnapshot(sessionId: string): Promise<DailyQueueSnapshot> {
  const session = await db.dailyLearningSessions.get(sessionId)
  if (!session) throw new Error('今日学习会话不存在')
  const [items, attempts] = await Promise.all([
    orderedItems(sessionId),
    db.dailyQueueAttempts.where('sessionId').equals(sessionId).sortBy('answeredAt'),
  ])
  const cardItems = items.filter((item) => item.kind === 'card')
  return {
    session,
    items,
    attempts,
    current: items.find((item) => item.status === 'pending' || item.status === 'active'),
    completedCards: session.initialWordIds.filter((wordId) => !cardItems.some((item) => item.wordId === wordId && (item.status === 'pending' || item.status === 'active'))).length,
    totalCards: session.initialWordIds.length,
  }
}

export async function getOrCreateDailySession(listIds?: string[], at = new Date()): Promise<DailyQueueSnapshot> {
  const today = dayKey(at)
  const storedSession = await db.dailyLearningSessions.where('dayKey').equals(today).first()
  if (storedSession) {
    const revision = await getStudyQueueRevision()
    const existing: DailyLearningSession = storedSession.sourceRevision ? storedSession : {
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
    return loadDailyQueueSnapshot(existing.sessionId)
  }

  const plan = await buildTodayPlan({ listIds, at })
  const firstRoundWordIds = plan.queueWordIds.slice(0, DAILY_ROUND_SIZE)
  const [states, revision] = await Promise.all([
    db.reviewState.bulkGet(firstRoundWordIds),
    getStudyQueueRevision(),
  ])
  const now = at.toISOString()
  const session: DailyLearningSession = {
    sessionId: `daily:${today}`,
    dayKey: today,
    status: 'active',
    phase: firstRoundWordIds.length ? 'cards' : 'article',
    selectedListIds: listIds ?? plan.listIds ?? [],
    initialWordIds: firstRoundWordIds,
    sourceRevision: revision,
    sourceEligibleWordIds: plan.eligibleWordIds ?? plan.queueWordIds,
    baseWordCount: plan.queueWordIds.length,
    extensionBatchCount: 0,
    activeRoundIndex: firstRoundWordIds.length ? 1 : 0,
    roundsJson: JSON.stringify(firstRoundWordIds.length ? [{ index: 1, wordIds: firstRoundWordIds, status: 'active', startedAt: now }] : []),
    articleStatus: 'waiting',
    createdAt: now,
    updatedAt: now,
  }
  const items = createInitialQueueItems(session, firstRoundWordIds, states, at)

  await db.transaction('rw', [db.dailyLearningSessions, db.dailyQueueItems], async () => {
    await db.dailyLearningSessions.add(session)
    if (items.length) await db.dailyQueueItems.bulkAdd(items)
  })
  await markPayloadChanged('dailyLearningSessions', session, now)
  for (const item of items) await markPayloadChanged('dailyQueueItems', item, now)
  return loadDailyQueueSnapshot(session.sessionId)
}

async function insertRepeat(
  current: DailyQueueItem,
  reason: DailyQueueReason,
  gap: number,
  outcome: ShortTermReviewOutcome,
): Promise<DailyQueueItem> {
  const now = new Date().toISOString()
  const pending = (await orderedItems(current.sessionId)).filter(
    (item) => item.itemId !== current.itemId && (item.status === 'pending' || item.status === 'active'),
  )
  const baseInsertAt = Math.min(gap, pending.length)
  const wordIds = [...new Set([...(current.wordId ? [current.wordId] : []), ...pending.flatMap((row) => row.wordId ? [row.wordId] : [])])]
  const words = await db.wordbook.bulkGet(wordIds)
  const initials = new Map(words.flatMap((word) => word
    ? [[word.wordId, (word.headwordLower ?? word.headword ?? '').replace(/^[^a-z]+/i, '').charAt(0).toLowerCase()] as const]
    : []))
  const currentInitial = current.wordId ? initials.get(current.wordId) : undefined
  const candidates = Array.from(
    { length: Math.min(pending.length, baseInsertAt + 2) - Math.max(0, baseInsertAt - 2) + 1 },
    (_, index) => Math.max(0, baseInsertAt - 2) + index,
  ).sort((left, right) => Math.abs(left - baseInsertAt) - Math.abs(right - baseInsertAt) || left - right)
  const insertAt = candidates.find((index) => {
    if (!currentInitial) return true
    const previousInitial = pending[index - 1]?.wordId ? initials.get(pending[index - 1]!.wordId!) : undefined
    const nextInitial = pending[index]?.wordId ? initials.get(pending[index]!.wordId!) : undefined
    return previousInitial !== currentInitial && nextInitial !== currentInitial
  }) ?? baseInsertAt
  const item: DailyQueueItem = {
    ...current,
    itemId: `${current.sessionId}:card:${current.wordId}:${current.attemptNo + 1}:${crypto.randomUUID()}`,
    reason,
    status: 'pending',
    attemptNo: current.attemptNo + 1,
    maxAttempts: MAX_DAILY_ATTEMPTS,
    todayMastery: outcome.mastery,
    recallStreak: outcome.recallStreak,
    weakSeen: outcome.weakSeen,
    attemptCount: current.attemptNo,
    nextGap: gap,
    createdAt: now,
    updatedAt: now,
  }
  pending.splice(insertAt, 0, item)
  const updates = pending.map((row, position) => ({ ...row, position, updatedAt: now }))
  await db.dailyQueueItems.bulkPut(updates)
  for (const row of updates) await markPayloadChanged('dailyQueueItems', row, now)
  return item
}

async function markTomorrowPriority(wordId: string): Promise<void> {
  const state = await db.reviewState.get(wordId)
  if (!state) return
  const tomorrow = dayjs().add(1, 'day').startOf('day').toISOString()
  await db.reviewState.put({ ...state, nextReviewAt: tomorrow, sameDayRelearnAt: undefined })
  await markRecordChanged('reviewState', wordId)
}

async function advanceSessionIfCardsDone(sessionId: string, at = new Date()): Promise<void> {
  const pending = await db.dailyQueueItems
    .where('sessionId')
    .equals(sessionId)
    .filter((item) => item.kind === 'card' && (item.status === 'pending' || item.status === 'active'))
    .count()
  if (pending > 0) return
  if (await startNextRound(sessionId, at)) return
  const session = await db.dailyLearningSessions.get(sessionId)
  if (!session) return
  const now = new Date().toISOString()
  const updated: DailyLearningSession = {
    ...session,
    cardsCompletedAt: session.cardsCompletedAt ?? now,
    updatedAt: now,
  }
  await db.dailyLearningSessions.put(updated)
  await markPayloadChanged('dailyLearningSessions', updated, now)
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
    updatedAt: now,
  }
  await db.dailyLearningSessions.put(updated)
  await markPayloadChanged('dailyLearningSessions', updated, now)
  return loadDailyQueueSnapshot(sessionId)
}

export async function answerDailyCard(
  sessionId: string,
  itemId: string,
  rating: ReviewRating,
  at = new Date(),
): Promise<DailyQueueSnapshot> {
  const item = await db.dailyQueueItems.get(itemId)
  if (!item?.wordId || item.sessionId !== sessionId || item.kind !== 'card') throw new Error('队列卡片不存在')
  const previousAttempts = await db.dailyQueueAttempts.where('[sessionId+wordId]').equals([sessionId, item.wordId]).toArray()
  const masteryBefore = item.todayMastery ?? 0
  const outcome = computeShortTermReview({
    mastery: masteryBefore,
    recallStreak: item.recallStreak,
    weakSeen: item.weakSeen,
    wasNew: item.wasNew,
    startingLongTermRetrievability: item.startingLongTermRetrievability,
  }, rating)
  const masteryAfter = outcome.mastery
  const ratings = [...previousAttempts.map((row) => row.rating), rating]
  const gap = outcome.reinsertionGap
  const reachedAttemptLimit = ratings.length >= MAX_DAILY_ATTEMPTS
  const wordCompleted = outcome.passed || reachedAttemptLimit
  const alreadyCommitted = previousAttempts.some((row) => row.committedToFsrs)
  const effectiveRating = aggregateSessionRating(ratings)
  if (wordCompleted && !alreadyCommitted) {
    await gradeCard(item.wordId, effectiveRating, at, {
      attemptCount: ratings.length,
      ratings,
      masteryBefore: item.todayMastery ?? 0,
      masteryAfter,
    })
  }

  const attempt: DailyQueueAttempt = {
    attemptId: `${sessionId}:${item.wordId}:${item.attemptNo}`,
    sessionId,
    itemId,
    wordId: item.wordId,
    rating,
    committedToFsrs: wordCompleted && !alreadyCommitted,
    masteryBefore,
    masteryAfter,
    reinsertionGap: wordCompleted ? 0 : gap,
    effectiveFsrsRating: wordCompleted && !alreadyCommitted ? effectiveRating : undefined,
    answeredAt: at.toISOString(),
  }
  const completed = {
    ...item,
    status: 'completed' as const,
    todayMastery: masteryAfter,
    recallStreak: outcome.recallStreak,
    weakSeen: outcome.weakSeen,
    updatedAt: attempt.answeredAt,
  }
  await db.transaction('rw', [db.dailyQueueItems, db.dailyQueueAttempts], async () => {
    await db.dailyQueueItems.put(completed)
    await db.dailyQueueAttempts.put(attempt)
  })
  await markPayloadChanged('dailyQueueItems', completed, attempt.answeredAt)
  await markPayloadChanged('dailyQueueAttempts', attempt, attempt.answeredAt)

  const repeatReason: DailyQueueReason = rating === 'again'
    ? 'again-repeat'
    : rating === 'hard' ? 'hard-repeat' : (item.reason === 'initial' ? 'new-repeat' : item.reason)

  if (!wordCompleted) {
    await insertRepeat(item, repeatReason, gap, outcome)
  } else if (reachedAttemptLimit && !outcome.passed) {
    completed.tomorrowPriority = true
    await db.dailyQueueItems.put(completed)
    await markPayloadChanged('dailyQueueItems', completed, attempt.answeredAt)
    await markTomorrowPriority(item.wordId)
  }
  await advanceSessionIfCardsDone(sessionId, at)
  return loadDailyQueueSnapshot(sessionId)
}

export async function enqueueContextRetry(sessionId: string, wordId: string): Promise<void> {
  const attempts = await db.dailyQueueAttempts.where('[sessionId+wordId]').equals([sessionId, wordId]).toArray()
  if (attempts.length >= 5) {
    await markTomorrowPriority(wordId)
    return
  }
  const now = new Date().toISOString()
  const pending = (await orderedItems(sessionId)).filter((item) => item.status === 'pending' || item.status === 'active')
  const item: DailyQueueItem = {
    itemId: `${sessionId}:context:${wordId}:${crypto.randomUUID()}`,
    sessionId,
    kind: 'card',
    wordId,
    reason: 'context-retry',
    position: pending.length,
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
  const session = await db.dailyLearningSessions.get(sessionId)
  if (session) {
    const updated = { ...session, phase: 'cards' as const, updatedAt: now }
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
    updatedAt: now,
  }
  await db.dailyLearningSessions.put(updated)
  await markPayloadChanged('dailyLearningSessions', updated, now)
}
