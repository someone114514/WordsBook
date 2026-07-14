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

const MAX_DAILY_ATTEMPTS = 5

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

export async function previewDailyQueueChanges(sessionId: string, at = new Date()): Promise<DailyQueueChangePreview> {
  const session = await db.dailyLearningSessions.get(sessionId)
  if (!session) throw new Error('今日学习会话不存在')
  const revision = await getStudyQueueRevision()
  if (revision === (session.sourceRevision ?? revision)) {
    return { revision, eligibleWordIds: session.sourceEligibleWordIds ?? session.initialWordIds, addedWordIds: [], removedWordIds: [], dismissed: false }
  }
  const [eligibleWordIds, attempts, items] = await Promise.all([
    listEligibleStudyWordIds([], session.selectedListIds.length ? session.selectedListIds : undefined, at),
    db.dailyQueueAttempts.where('sessionId').equals(sessionId).toArray(),
    db.dailyQueueItems.where('sessionId').equals(sessionId).toArray(),
  ])
  const eligible = new Set(eligibleWordIds)
  const attempted = new Set(attempts.map((attempt) => attempt.wordId))
  const baseline = new Set(session.sourceEligibleWordIds ?? eligibleWordIds)
  const included = new Set(session.initialWordIds)
  const pendingWordIds = new Set(items.filter((item) => item.wordId && (item.status === 'pending' || item.status === 'active')).map((item) => item.wordId!))
  return {
    revision,
    eligibleWordIds,
    addedWordIds: eligibleWordIds.filter((wordId) => !baseline.has(wordId) && !included.has(wordId)),
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
    completedAt: addedItems.length ? undefined : session.completedAt,
    updatedAt: now,
  }
  await db.transaction('rw', [db.dailyLearningSessions, db.dailyQueueItems], async () => {
    if (skippedItems.length) await db.dailyQueueItems.bulkPut(skippedItems)
    if (addedItems.length) await db.dailyQueueItems.bulkPut(addedItems)
    await db.dailyLearningSessions.put(updated)
  })
  for (const item of [...skippedItems, ...addedItems]) await markPayloadChanged('dailyQueueItems', item, now)
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
  const [states, revision, eligibleWordIds] = await Promise.all([
    db.reviewState.bulkGet(plan.queueWordIds),
    getStudyQueueRevision(),
    listEligibleStudyWordIds([], listIds, at),
  ])
  const now = at.toISOString()
  const session: DailyLearningSession = {
    sessionId: `daily:${today}`,
    dayKey: today,
    status: 'active',
    phase: plan.queueWordIds.length ? 'cards' : 'article',
    selectedListIds: listIds ?? plan.listIds ?? [],
    initialWordIds: plan.queueWordIds,
    sourceRevision: revision,
    sourceEligibleWordIds: eligibleWordIds,
    baseWordCount: plan.queueWordIds.length,
    extensionBatchCount: 0,
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
