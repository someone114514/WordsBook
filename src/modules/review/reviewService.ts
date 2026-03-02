import dayjs from 'dayjs'
import { db } from '../../db/database'
import type { ReviewCard, ReviewState, StudyPlan } from '../../types/models'
import { applyAiOverrides } from '../dictionary/entryOverrideMapper'
import { loadSettings } from '../settings/settingsService'
import { computeNextReviewState, type ReviewRating } from './scheduler'

interface BuildPlanOptions {
  at?: Date
  dailyNewLimit?: number
  dailyReviewLimit?: number
}

const FOCUS_OVERDUE_DAYS = 2

interface PlanCache {
  plan: StudyPlan
  createdAt: number
  fingerprint: string
  dayKey: string
}

const PLAN_CACHE_REFRESH_MS = 3 * 60 * 1000
let planCache: PlanCache | null = null

async function getActiveStateRows(): Promise<Array<{ wordId: string; state: ReviewState }>> {
  const wordbookRows = await db.wordbook.where('archived').equals(0).toArray()
  const stateRows = await db.reviewState.bulkGet(wordbookRows.map((row) => row.wordId))
  const stateMap = new Map(
    stateRows
      .filter((state): state is NonNullable<typeof state> => state !== undefined)
      .map((state) => [state.wordId, state]),
  )
  const missingStates: ReviewState[] = []
  const activeRows: Array<{ wordId: string; state: ReviewState }> = []

  for (const wordbookRow of wordbookRows) {
    const existingState = stateMap.get(wordbookRow.wordId)
    if (existingState) {
      activeRows.push({ wordId: wordbookRow.wordId, state: existingState })
      continue
    }

    const fallbackState: ReviewState = {
      wordId: wordbookRow.wordId,
      cycle: 0,
      nextReviewAt: wordbookRow.addedAt,
      successCount: 0,
      lapseCount: 0,
      totalReviews: 0,
    }
    missingStates.push(fallbackState)
    activeRows.push({ wordId: wordbookRow.wordId, state: fallbackState })
  }

  if (missingStates.length > 0) {
    await db.reviewState.bulkPut(missingStates)
  }

  return activeRows
}

export async function buildTodayPlan(options: BuildPlanOptions = {}): Promise<StudyPlan> {
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

  const rows = await getActiveStateRows()

  const getOverdueDays = (nextReviewAt: string) => dayjs(nowIso).diff(nextReviewAt, 'day', true)

  const dueRows = rows
    .filter((row) => row.state.totalReviews > 0 && !dayjs(row.state.nextReviewAt).isAfter(nowIso))
    .sort((left, right) => {
      const leftOverdueDays = getOverdueDays(left.state.nextReviewAt)
      const rightOverdueDays = getOverdueDays(right.state.nextReviewAt)

      // Prioritize items close to the intended review window first.
      const leftTier = leftOverdueDays <= FOCUS_OVERDUE_DAYS ? 0 : 1
      const rightTier = rightOverdueDays <= FOCUS_OVERDUE_DAYS ? 0 : 1
      if (leftTier !== rightTier) {
        return leftTier - rightTier
      }

      if (Math.abs(leftOverdueDays - rightOverdueDays) > 1e-6) {
        return leftOverdueDays - rightOverdueDays
      }

      return left.state.nextReviewAt.localeCompare(right.state.nextReviewAt)
    })

  const newRows = rows
    .filter((row) => row.state.totalReviews === 0)
    .sort((left, right) => left.state.nextReviewAt.localeCompare(right.state.nextReviewAt))

  const selectedDue = dueRows.slice(0, dailyReviewLimit)
  const reviewCapacityLeft = Math.max(0, dailyReviewLimit - selectedDue.length)
  let selectedNew = newRows.slice(0, Math.min(dailyNewLimit, reviewCapacityLeft))

  // Keep at least one actionable card when new rows exist but limits currently produce an empty queue.
  if (selectedDue.length === 0 && selectedNew.length === 0 && newRows.length > 0) {
    const fallbackNew = newRows[0]
    if (fallbackNew) {
      selectedNew = [fallbackNew]
    }
  }

  return {
    dueCount: dueRows.length,
    newCount: newRows.length,
    queueWordIds: [...selectedDue, ...selectedNew].map((row) => row.wordId),
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
      const entry = entryMap.get(item.entryId)
      const reviewState = states[index]
      if (!entry || !reviewState) {
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
): Promise<ReviewState> {
  const reviewedAtIso = reviewedAt.toISOString()

  return db.transaction('rw', db.reviewState, db.reviewLogs, async () => {
    const state = await db.reviewState.get(wordId)
    if (!state) {
      throw new Error('Review state missing')
    }

    const computed = computeNextReviewState(state, rating, reviewedAtIso)

    const updatedState: ReviewState = {
      ...state,
      cycle: computed.cycleAfter,
      lastReviewedAt: reviewedAtIso,
      nextReviewAt: computed.nextReviewAtAfter,
      successCount: state.successCount + (rating === 'remember' ? 1 : 0),
      lapseCount: state.lapseCount + (rating === 'forget' ? 1 : 0),
      totalReviews: state.totalReviews + 1,
    }

    await db.reviewState.put(updatedState)
    await db.reviewLogs.add({
      wordId,
      reviewedAt: reviewedAtIso,
      rating,
      cycleBefore: computed.cycleBefore,
      cycleAfter: computed.cycleAfter,
      nextReviewAtBefore: computed.nextReviewAtBefore,
      nextReviewAtAfter: computed.nextReviewAtAfter,
    })
    invalidateStudyPlanCache()

    return updatedState
  })
}
