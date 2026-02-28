import dayjs from 'dayjs'
import type { ReviewState } from '../../types/models'

export const REVIEW_INTERVAL_DAYS = [0, 1, 2, 4, 7, 15, 30, 60] as const

export type ReviewRating = 'remember' | 'forget'

export interface NextReviewComputation {
  cycleBefore: number
  cycleAfter: number
  nextReviewAtBefore: string
  nextReviewAtAfter: string
}

export function clampCycle(cycle: number): number {
  return Math.max(0, Math.min(REVIEW_INTERVAL_DAYS.length - 1, cycle))
}

export function computeNextReviewAt(reviewedAt: string, cycle: number): string {
  const safeCycle = clampCycle(cycle)
  const days = REVIEW_INTERVAL_DAYS[safeCycle] ?? 0
  return dayjs(reviewedAt).add(days, 'day').toISOString()
}

export function computeNextReviewState(
  state: ReviewState,
  rating: ReviewRating,
  reviewedAt: string,
): NextReviewComputation {
  const cycleBefore = clampCycle(state.cycle)
  const cycleAfter = rating === 'remember' ? clampCycle(cycleBefore + 1) : clampCycle(cycleBefore - 1)

  return {
    cycleBefore,
    cycleAfter,
    nextReviewAtBefore: state.nextReviewAt,
    nextReviewAtAfter: computeNextReviewAt(reviewedAt, cycleAfter),
  }
}
