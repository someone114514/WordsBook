import dayjs from 'dayjs'
import { db } from '../../db/database'
import type { ReviewCard, ReviewRating, ReviewState, StudyPlan, WordbookItem } from '../../types/models'
import { dictionaryEntryFromWordbook, repairVocabularyIntegrity } from '../wordbook/vocabularyIntegrity'
import { applyAiOverrides } from '../dictionary/entryOverrideMapper'
import { loadSettings } from '../settings/settingsService'
import { markPayloadChanged, markRecordChanged } from '../sync/localSyncStore'
import {
  cardToReviewState,
  formatInterval,
  migrateLegacyReviewState,
  previewFsrsReviews,
  scheduleFsrsReview,
  getReviewRetrievability,
} from './scheduler'

interface BuildPlanOptions {
  at?: Date
  dailyNewLimit?: number
  dailyReviewLimit?: number
  listIds?: string[]
}

interface PlanCache {
  plan: StudyPlan
  createdAt: number
  fingerprint: string
  dayKey: string
}

const PLAN_CACHE_REFRESH_MS = 3 * 60 * 1000
let planCache: PlanCache | null = null

async function getStudyWordbookRows(listIds?: string[]): Promise<Array<{ word: WordbookItem; listIds: string[] }>> {
  const enabledLists = listIds?.length
    ? await db.studyLists.where('listId').anyOf(listIds).toArray()
    : await db.studyLists.where('studyEnabled').equals(1).toArray()
  const activeListIds = enabledLists
    .filter((list) => list.studyEnabled === 1 || Boolean(listIds?.includes(list.listId)))
    .map((list) => list.listId)
  if (activeListIds.length === 0) return []
  const memberships = await db.studyListItems.where('listId').anyOf(activeListIds).toArray()
  const membershipMap = new Map<string, string[]>()
  for (const membership of memberships) {
    const bucket = membershipMap.get(membership.wordId) ?? []
    bucket.push(membership.listId)
    membershipMap.set(membership.wordId, bucket)
  }
  const wordIds = [...membershipMap.keys()]
  const words = await db.wordbook.bulkGet(wordIds)
  return words
    .filter((row): row is WordbookItem => Boolean(row && row.archived === 0 && row.integrityStatus !== 'needs-repair'))
    .map((word) => ({ word, listIds: membershipMap.get(word.wordId) ?? [] }))
}

async function getActiveStateRows(listIds?: string[]): Promise<Array<{ wordId: string; state: ReviewState; listIds: string[] }>> {
  const wordbookRows = await getStudyWordbookRows(listIds)
  const stateRows = await db.reviewState.bulkGet(wordbookRows.map((row) => row.word.wordId))
  const stateMap = new Map(
    stateRows
      .filter((state): state is NonNullable<typeof state> => state !== undefined)
      .map((state) => [state.wordId, state]),
  )
  const missingStates: ReviewState[] = []
  const activeRows: Array<{ wordId: string; state: ReviewState; listIds: string[] }> = []

  for (const wordbookRow of wordbookRows) {
    const existingState = stateMap.get(wordbookRow.word.wordId)
    if (existingState) {
      activeRows.push({ wordId: wordbookRow.word.wordId, state: existingState, listIds: wordbookRow.listIds })
      continue
    }

    const fallbackState: ReviewState = {
      wordId: wordbookRow.word.wordId,
      cycle: 0,
      nextReviewAt: wordbookRow.word.addedAt,
      successCount: 0,
      lapseCount: 0,
      totalReviews: 0,
    }
    missingStates.push(fallbackState)
    activeRows.push({ wordId: wordbookRow.word.wordId, state: fallbackState, listIds: wordbookRow.listIds })
  }

  if (missingStates.length > 0) {
    await db.reviewState.bulkPut(missingStates)
  }

  const legacyRows = activeRows.filter((row) => row.state.schedulerVersion !== 'fsrs-5')
  if (legacyRows.length > 0) {
    const legacyIds = new Set(legacyRows.map((row) => row.wordId))
    const logs = (await db.reviewLogs.toArray()).filter((log) => legacyIds.has(log.wordId))
    const logsByWord = new Map<string, typeof logs>()
    for (const log of logs) {
      const bucket = logsByWord.get(log.wordId) ?? []
      bucket.push(log)
      logsByWord.set(log.wordId, bucket)
    }
    const addedAt = new Map(wordbookRows.map((row) => [row.word.wordId, row.word.addedAt]))
    for (const row of legacyRows) {
      row.state = migrateLegacyReviewState(
        row.state,
        logsByWord.get(row.wordId) ?? [],
        addedAt.get(row.wordId) ?? row.state.nextReviewAt,
      )
    }
    await db.reviewState.bulkPut(legacyRows.map((row) => row.state))
  }

  return activeRows
}

export async function buildTodayPlan(options: BuildPlanOptions = {}): Promise<StudyPlan> {
  await repairVocabularyIntegrity()
  const requiresSettings =
    options.dailyNewLimit === undefined || options.dailyReviewLimit === undefined
  const settings = requiresSettings ? await loadSettings() : null
  const now = options.at ?? new Date()
  const nowIso = now.toISOString()

  const dailyNewLimit = Math.max(0, Math.floor(options.dailyNewLimit ?? settings?.dailyNewLimit ?? 20))
  const dailyReviewLimit = Math.max(
    0,
    Math.floor(options.dailyReviewLimit ?? settings?.dailyReviewLimit ?? 200),
  )

  const rows = await getActiveStateRows(options.listIds)

  const dueRows = rows
    .filter((row) => {
      if (row.state.suspendedAt) return false
      return (row.state.reps ?? row.state.totalReviews) > 0 && !dayjs(row.state.nextReviewAt).isAfter(nowIso)
    })
    .sort((left, right) => {
      const retrievabilityDiff = getReviewRetrievability(left.state, now) - getReviewRetrievability(right.state, now)
      if (Math.abs(retrievabilityDiff) > 1e-6) return retrievabilityDiff
      return left.state.nextReviewAt.localeCompare(right.state.nextReviewAt)
    })

  const newRows = rows
    .filter((row) => !row.state.suspendedAt && (row.state.reps ?? row.state.totalReviews) === 0)
    .sort((left, right) => left.state.nextReviewAt.localeCompare(right.state.nextReviewAt))

  const selectedDue = dueRows.slice(0, dailyReviewLimit)
  const effectiveNewLimit = dueRows.length > dailyReviewLimit
    ? 0
    : dueRows.length > dailyReviewLimit * 0.5
      ? Math.ceil(dailyNewLimit / 2)
      : dailyNewLimit
  const enabledListIds = [...new Set(rows.flatMap((row) => row.listIds))]
  const newByList = new Map(enabledListIds.map((listId) => [listId, newRows.filter((row) => row.listIds.includes(listId))]))
  const selectedNew: typeof newRows = []
  const selectedNewIds = new Set<string>()
  while (selectedNew.length < effectiveNewLimit) {
    let added = false
    for (const listId of enabledListIds) {
      const bucket = newByList.get(listId) ?? []
      const row = bucket.find((candidate) => !selectedNewIds.has(candidate.wordId))
      if (!row) continue
      selectedNew.push(row)
      selectedNewIds.add(row.wordId)
      added = true
      if (selectedNew.length >= effectiveNewLimit) break
    }
    if (!added) break
  }

  // Keep at least one actionable card when new rows exist but limits currently produce an empty queue.
  if (selectedDue.length === 0 && selectedNew.length === 0 && newRows.length > 0) {
    const fallbackNew = newRows[0]
    if (fallbackNew) {
      selectedNew.push(fallbackNew)
    }
  }

  const selectedRows = [...selectedDue, ...selectedNew]
  const activeLists = await db.studyLists.bulkGet(enabledListIds)
  const listContributions = activeLists.flatMap((list, index) => list ? [{
    listId: enabledListIds[index]!,
    name: list.name,
    count: selectedRows.filter((row) => row.listIds.includes(enabledListIds[index]!)).length,
  }] : [])
  const previousSession = await db.dailyLearningSessions.orderBy('dayKey').last()
  const daysSinceLastStudy = previousSession ? Math.max(0, dayjs(now).startOf('day').diff(previousSession.dayKey, 'day')) : 0

  return {
    dueCount: dueRows.length,
    newCount: newRows.length,
    queueWordIds: selectedRows.map((row) => row.wordId),
    laterTodayCount: 0,
    listIds: options.listIds,
    effectiveNewLimit,
    recoveryDays: dailyReviewLimit > 0 ? Math.max(1, Math.ceil(dueRows.length / dailyReviewLimit)) : 0,
    daysSinceLastStudy,
    listContributions,
  }
}

function getTodayKey(date = new Date()): string {
  return dayjs(date).format('YYYY-MM-DD')
}

async function getPlanFingerprint(
  dailyNewLimit: number,
  dailyReviewLimit: number,
): Promise<string> {
  const [activeCount, latestWordbookRow, latestReviewLog] = await Promise.all([
    db.wordbook.where('archived').equals(0).count(),
    db.wordbook.orderBy('addedAt').last(),
    db.reviewLogs.orderBy('id').last(),
  ])

  return [
    activeCount,
    latestWordbookRow?.addedAt ?? '-',
    latestReviewLog?.id ?? 0,
    dailyNewLimit,
    dailyReviewLimit,
  ].join('|')
}

export function getCachedStudyPlan(): StudyPlan | null {
  if (!planCache) {
    return null
  }

  const isToday = planCache.dayKey === getTodayKey()
  const isFresh = Date.now() - planCache.createdAt < PLAN_CACHE_REFRESH_MS
  if (isToday && isFresh) {
    return planCache.plan
  }

  return null
}

export function invalidateStudyPlanCache(): void {
  planCache = null
}

export async function buildTodayPlanCached(): Promise<StudyPlan> {
  if (planCache && planCache.dayKey === getTodayKey() && Date.now() - planCache.createdAt < PLAN_CACHE_REFRESH_MS) {
    return planCache.plan
  }

  const settings = await loadSettings()
  const dayKey = getTodayKey()
  const fingerprint = await getPlanFingerprint(settings.dailyNewLimit, settings.dailyReviewLimit)
  const now = Date.now()

  if (
    planCache &&
    planCache.dayKey === dayKey &&
    planCache.fingerprint === fingerprint &&
    now - planCache.createdAt < PLAN_CACHE_REFRESH_MS
  ) {
    return planCache.plan
  }

  const plan = await buildTodayPlan({
    dailyNewLimit: settings.dailyNewLimit,
    dailyReviewLimit: settings.dailyReviewLimit,
  })

  planCache = {
    plan,
    createdAt: now,
    fingerprint,
    dayKey,
  }

  return plan
}

export async function loadReviewCards(wordIds: string[]): Promise<ReviewCard[]> {
  if (wordIds.length === 0) {
    return []
  }

  await repairVocabularyIntegrity(wordIds)
  const wordbookRows = await db.wordbook.bulkGet(wordIds)
  const filteredWordbookRows = wordbookRows.filter((row): row is NonNullable<typeof row> => row !== undefined)

  const [rawEntries, states] = await Promise.all([
    db.dictionaryEntries.bulkGet(filteredWordbookRows.map((row) => row.entryId)),
    db.reviewState.bulkGet(filteredWordbookRows.map((row) => row.wordId)),
  ])

  const entries = await applyAiOverrides(
    rawEntries.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
  )
  const entryMap = new Map(entries.map((entry) => [entry.entryId, entry]))

  return filteredWordbookRows
    .map((item, index) => {
      const entry = entryMap.get(item.entryId) ?? dictionaryEntryFromWordbook(item)
      const reviewState = states[index]
      if (!reviewState || !entry) {
        return undefined
      }

      return {
        wordId: item.wordId,
        entryId: item.entryId,
        note: item.note,
        tags: item.tags,
        entry,
        reviewState,
      }
    })
    .filter((card): card is ReviewCard => card !== undefined)
}

export async function gradeCard(
  wordId: string,
  rating: ReviewRating,
  reviewedAt = new Date(),
  session?: {
    attemptCount: number
    ratings: ReviewRating[]
    masteryBefore: number
    masteryAfter: number
  },
): Promise<ReviewState> {
  const reviewedAtIso = reviewedAt.toISOString()

  return db.transaction('rw', [db.reviewState, db.reviewLogs, db.syncMeta, db.syncRecords, db.syncTombstones], async () => {
    const state = await db.reviewState.get(wordId)
    if (!state) {
      throw new Error('Review state missing')
    }

    const normalizedState = state.schedulerVersion === 'fsrs-5'
      ? state
      : migrateLegacyReviewState(
          state,
          await db.reviewLogs.where('wordId').equals(wordId).toArray(),
          state.nextReviewAt,
        )
    const result = scheduleFsrsReview(normalizedState, rating, reviewedAt)

    const updatedState: ReviewState = {
      ...cardToReviewState(wordId, result.card, normalizedState),
      cycle: normalizedState.cycle,
      successCount: normalizedState.successCount + (rating === 'good' ? 1 : 0),
      lapseCount: result.card.lapses,
      totalReviews: result.card.reps,
      sameDayRelearnAt: undefined,
    }

    await db.reviewState.put(updatedState)
    const log = {
      wordId,
      reviewedAt: reviewedAtIso,
      rating,
      source: 'flashcard' as const,
      wasNew: (normalizedState.reps ?? normalizedState.totalReviews) === 0,
      cycleBefore: normalizedState.cycle,
      cycleAfter: updatedState.cycle,
      nextReviewAtBefore: normalizedState.nextReviewAt,
      nextReviewAtAfter: updatedState.nextReviewAt,
      stateBefore: normalizedState.fsrsState,
      stateAfter: updatedState.fsrsState,
      stabilityBefore: normalizedState.stability,
      stabilityAfter: updatedState.stability,
      difficultyBefore: normalizedState.difficulty,
      difficultyAfter: updatedState.difficulty,
      sessionAttemptCount: session?.attemptCount,
      sessionRatings: session?.ratings,
      todayMasteryBefore: session?.masteryBefore,
      todayMasteryAfter: session?.masteryAfter,
    }
    await db.reviewLogs.add(log)
    await markRecordChanged('reviewState', wordId, reviewedAtIso)
    await markPayloadChanged('reviewLogs', log, reviewedAtIso)
    invalidateStudyPlanCache()

    return updatedState
  })
}

export async function previewCardIntervals(
  wordId: string,
  reviewedAt = new Date(),
): Promise<Record<ReviewRating, string>> {
  const state = await db.reviewState.get(wordId)
  if (!state) throw new Error('Review state missing')
  const preview = previewFsrsReviews(state, reviewedAt)
  return {
    again: formatInterval(reviewedAt, preview.again.card.due),
    hard: formatInterval(reviewedAt, preview.hard.card.due),
    good: formatInterval(reviewedAt, preview.good.card.due),
  }
}

export async function setWordSuspended(wordId: string, suspended: boolean): Promise<void> {
  const state = await db.reviewState.get(wordId)
  if (!state) throw new Error('Review state missing')
  await db.reviewState.put({ ...state, suspendedAt: suspended ? new Date().toISOString() : undefined })
  await markRecordChanged('reviewState', wordId)
  invalidateStudyPlanCache()
}
