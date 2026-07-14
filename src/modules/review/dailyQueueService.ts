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
import { buildTodayPlan, gradeCard } from './reviewService'
import { getReviewRetrievability } from './scheduler'
import { repairVocabularyIntegrity } from '../wordbook/vocabularyIntegrity'
import { loadSettings } from '../settings/settingsService'

const MAX_DAILY_ATTEMPTS = 5

export interface DailyQueueSnapshot {
  session: DailyLearningSession
  items: DailyQueueItem[]
  attempts: DailyQueueAttempt[]
  current?: DailyQueueItem
  completedCards: number
  totalCards: number
}

function dayKey(at = new Date()): string {
  return dayjs(at).format('YYYY-MM-DD')
}

export function initialTodayMastery(retrievability: number, isNew: boolean): number {
  if (isNew || retrievability < 0.5) return 0
  if (retrievability < 0.75) return 20
  if (retrievability < 0.9) return 30
  return 40
}

export function nextTodayMastery(current: number, rating: ReviewRating): number {
  if (rating === 'again') return 0
  return Math.min(100, current + (rating === 'hard' ? 40 : 60))
}

export function masteryReinsertionGap(mastery: number): number {
  if (mastery >= 100) return 0
  if (mastery >= 70) return 7
  if (mastery >= 40) return 4
  return 2
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
      position: index,
      status: 'pending',
      attemptNo: 1,
      maxAttempts: MAX_DAILY_ATTEMPTS,
      retrievability,
      startingLongTermRetrievability: retrievability,
      wasNew: isNew,
      todayMastery: initialTodayMastery(retrievability, isNew),
      attemptCount: 0,
      nextGap: 0,
      tomorrowPriority: false,
      createdAt: now,
      updatedAt: now,
    }
  })
}

async function refreshCurrentSession(
  existing: DailyLearningSession,
  listIds: string[] | undefined,
  at: Date,
): Promise<DailyLearningSession> {
  if (existing.status !== 'active' || existing.articleStatus !== 'waiting') return existing
  const requestedListIds = listIds ?? (existing.selectedListIds.length ? existing.selectedListIds : undefined)
  const [attempts, existingItems, settings] = await Promise.all([
    db.dailyQueueAttempts.where('sessionId').equals(existing.sessionId).toArray(),
    db.dailyQueueItems.where('sessionId').equals(existing.sessionId).toArray(),
    loadSettings(),
  ])
  const attemptedWordIds = [...new Set(attempts.map((attempt) => attempt.wordId))]
  const attemptedSet = new Set(attemptedWordIds)
  const firstItems = new Map<string, DailyQueueItem>()
  for (const item of existingItems.slice().sort((left, right) => left.attemptNo - right.attemptNo)) {
    if (item.wordId && !firstItems.has(item.wordId)) firstItems.set(item.wordId, item)
  }
  const [attemptedStates, attemptedLogs] = await Promise.all([
    db.reviewState.bulkGet(attemptedWordIds),
    attemptedWordIds.length ? db.reviewLogs.where('wordId').anyOf(attemptedWordIds).toArray() : [],
  ])
  let attemptedNew = 0
  let attemptedReview = 0
  for (const [index, wordId] of attemptedWordIds.entries()) {
    const item = firstItems.get(wordId)
    const state = attemptedStates[index]
    const sameDayLog = attemptedLogs.find((log) => log.wordId === wordId && dayKey(new Date(log.reviewedAt)) === existing.dayKey)
    const wasNew = item?.wasNew ?? sameDayLog?.wasNew ?? (state?.reps ?? state?.totalReviews ?? 0) === 0
    if (wasNew) attemptedNew += 1
    else attemptedReview += 1
  }

  const plan = await buildTodayPlan({
    listIds: requestedListIds,
    at,
    dailyNewLimit: Math.max(0, settings.dailyNewLimit - attemptedNew),
    dailyReviewLimit: Math.max(0, settings.dailyReviewLimit - attemptedReview),
    excludeWordIds: attemptedWordIds,
  })
  const plannedSet = new Set(plan.queueWordIds)
  const activeItems = existingItems
    .filter((item) => item.kind === 'card' && (item.status === 'pending' || item.status === 'active'))
    .sort((left, right) => left.position - right.position)
  const retained = activeItems.filter((item) => Boolean(item.wordId && (attemptedSet.has(item.wordId) || plannedSet.has(item.wordId))))
  const retainedWordIds = new Set(retained.flatMap((item) => item.wordId ? [item.wordId] : []))
  const addedWordIds = plan.queueWordIds.filter((wordId) => !retainedWordIds.has(wordId))
  const states = await db.reviewState.bulkGet(addedWordIds)
  const placeholderSession = { ...existing, selectedListIds: requestedListIds ?? [] }
  const addedItems = createInitialQueueItems(placeholderSession, addedWordIds, states, at)
    .map((item) => ({ ...item, itemId: `${existing.sessionId}:card:refresh:${crypto.randomUUID()}` }))
  const pendingItems = [...retained, ...addedItems]
    .map((item, position) => ({ ...item, position, updatedAt: at.toISOString() }))
  const removedItems = activeItems.filter((item) => !pendingItems.some((pending) => pending.itemId === item.itemId))
    .map((item) => ({ ...item, status: 'skipped' as const, updatedAt: at.toISOString() }))
  const initialWordIds = [
    ...existing.initialWordIds.filter((wordId) => attemptedSet.has(wordId)),
    ...plan.queueWordIds,
  ].filter((wordId, index, rows) => rows.indexOf(wordId) === index)
  const unchanged = initialWordIds.length === existing.initialWordIds.length
    && initialWordIds.every((wordId, index) => wordId === existing.initialWordIds[index])
    && addedItems.length === 0
    && removedItems.length === 0
  if (unchanged) return existing

  const now = at.toISOString()
  const updated: DailyLearningSession = {
    ...existing,
    phase: pendingItems.length ? 'cards' : 'article',
    selectedListIds: requestedListIds ?? [],
    initialWordIds,
    cardsCompletedAt: pendingItems.length ? undefined : existing.cardsCompletedAt ?? now,
    updatedAt: now,
  }
  await db.transaction('rw', [db.dailyLearningSessions, db.dailyQueueItems], async () => {
    if (removedItems.length) await db.dailyQueueItems.bulkPut(removedItems)
    if (pendingItems.length) await db.dailyQueueItems.bulkPut(pendingItems)
    await db.dailyLearningSessions.put(updated)
  })
  for (const item of removedItems) await markPayloadChanged('dailyQueueItems', item, now)
  for (const item of pendingItems) await markPayloadChanged('dailyQueueItems', item, now)
  await markPayloadChanged('dailyLearningSessions', updated, now)
  return updated
}

async function orderedItems(sessionId: string): Promise<DailyQueueItem[]> {
  return db.dailyQueueItems.where('sessionId').equals(sessionId).sortBy('position')
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
    const existing = await refreshCurrentSession(storedSession, listIds, at)
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
  const states = await db.reviewState.bulkGet(plan.queueWordIds)
  const now = at.toISOString()
  const session: DailyLearningSession = {
    sessionId: `daily:${today}`,
    dayKey: today,
    status: 'active',
    phase: plan.queueWordIds.length ? 'cards' : 'article',
    selectedListIds: listIds ?? plan.listIds ?? [],
    initialWordIds: plan.queueWordIds,
    articleStatus: 'waiting',
    createdAt: now,
    updatedAt: now,
  }
  const items = createInitialQueueItems(session, plan.queueWordIds, states, at)

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
  mastery: number,
): Promise<DailyQueueItem> {
  const now = new Date().toISOString()
  const pending = (await orderedItems(current.sessionId)).filter(
    (item) => item.itemId !== current.itemId && (item.status === 'pending' || item.status === 'active'),
  )
  const insertAt = Math.min(gap, pending.length)
  const item: DailyQueueItem = {
    ...current,
    itemId: `${current.sessionId}:card:${current.wordId}:${current.attemptNo + 1}:${crypto.randomUUID()}`,
    reason,
    status: 'pending',
    attemptNo: current.attemptNo + 1,
    maxAttempts: MAX_DAILY_ATTEMPTS,
    todayMastery: mastery,
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

async function advanceSessionIfCardsDone(sessionId: string): Promise<void> {
  const pending = await db.dailyQueueItems
    .where('sessionId')
    .equals(sessionId)
    .filter((item) => item.kind === 'card' && (item.status === 'pending' || item.status === 'active'))
    .count()
  if (pending > 0) return
  const session = await db.dailyLearningSessions.get(sessionId)
  if (!session) return
  const now = new Date().toISOString()
  const updated: DailyLearningSession = {
    ...session,
    phase: session.articleStatus === 'completed' ? 'summary' : 'article',
    status: session.articleStatus === 'completed' ? 'completed' : session.status,
    cardsCompletedAt: session.cardsCompletedAt ?? now,
    completedAt: session.articleStatus === 'completed' ? now : session.completedAt,
    updatedAt: now,
  }
  await db.dailyLearningSessions.put(updated)
  await markPayloadChanged('dailyLearningSessions', updated, now)
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
  const masteryAfter = nextTodayMastery(masteryBefore, rating)
  const ratings = [...previousAttempts.map((row) => row.rating), rating]
  const gap = masteryReinsertionGap(masteryAfter)
  const reachedAttemptLimit = ratings.length >= MAX_DAILY_ATTEMPTS
  const wordCompleted = masteryAfter >= 100 || reachedAttemptLimit
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
  const completed = { ...item, status: 'completed' as const, updatedAt: attempt.answeredAt }
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
    await insertRepeat(item, repeatReason, gap, masteryAfter)
  } else if (reachedAttemptLimit && masteryAfter < 100) {
    completed.tomorrowPriority = true
    await db.dailyQueueItems.put(completed)
    await markPayloadChanged('dailyQueueItems', completed, attempt.answeredAt)
    await markTomorrowPriority(item.wordId)
  }
  await advanceSessionIfCardsDone(sessionId)
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
  const updated = { ...session, articleStatus, updatedAt: now }
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
