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

async function getActiveStateRows(): Promise<Array<{ wordId: string; state: ReviewState }>> {
  const [wordbookRows, stateRows] = await Promise.all([
    db.wordbook.where('archived').equals(0).toArray(),
    db.reviewState.toArray(),
  ])

  const activeWordIds = new Set(wordbookRows.map((row) => row.wordId))
  return stateRows
    .filter((state) => activeWordIds.has(state.wordId))
    .map((state) => ({ wordId: state.wordId, state }))
}

export async function buildTodayPlan(options: BuildPlanOptions = {}): Promise<StudyPlan> {
  const settings = await loadSettings()
  const now = options.at ?? new Date()
  const nowIso = now.toISOString()

  const dailyNewLimit = options.dailyNewLimit ?? settings.dailyNewLimit
  const dailyReviewLimit = options.dailyReviewLimit ?? settings.dailyReviewLimit

  const rows = await getActiveStateRows()

  const dueRows = rows
    .filter((row) => row.state.totalReviews > 0 && dayjs(row.state.nextReviewAt).isBefore(nowIso))
    .sort((left, right) => left.state.nextReviewAt.localeCompare(right.state.nextReviewAt))

  const newRows = rows
    .filter((row) => row.state.totalReviews === 0)
    .sort((left, right) => left.state.nextReviewAt.localeCompare(right.state.nextReviewAt))

  const selectedDue = dueRows.slice(0, dailyReviewLimit)
  const reviewCapacityLeft = Math.max(0, dailyReviewLimit - selectedDue.length)
  const selectedNew = newRows.slice(0, Math.min(dailyNewLimit, reviewCapacityLeft))

  return {
    dueCount: dueRows.length,
    newCount: newRows.length,
    queueWordIds: [...selectedDue, ...selectedNew].map((row) => row.wordId),
  }
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

    return updatedState
  })
}
