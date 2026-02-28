import dayjs from 'dayjs'
import { describe, expect, it } from 'vitest'
import { computeNextReviewAt, computeNextReviewState, REVIEW_INTERVAL_DAYS } from './scheduler'

describe('review scheduler', () => {
  it('computes next review date by cycle', () => {
    const now = '2026-02-28T00:00:00.000Z'
    const next = computeNextReviewAt(now, 3)
    expect(next).toBe(dayjs(now).add(REVIEW_INTERVAL_DAYS[3], 'day').toISOString())
  })

  it('advances cycle on remember', () => {
    const state = {
      wordId: 'w1',
      cycle: 2,
      nextReviewAt: '2026-03-01T00:00:00.000Z',
      successCount: 0,
      lapseCount: 0,
      totalReviews: 0,
    }

    const updated = computeNextReviewState(state, 'remember', '2026-03-02T00:00:00.000Z')
    expect(updated.cycleBefore).toBe(2)
    expect(updated.cycleAfter).toBe(3)
  })

  it('decreases cycle on forget and never below zero', () => {
    const state = {
      wordId: 'w1',
      cycle: 0,
      nextReviewAt: '2026-03-01T00:00:00.000Z',
      successCount: 0,
      lapseCount: 0,
      totalReviews: 0,
    }

    const updated = computeNextReviewState(state, 'forget', '2026-03-02T00:00:00.000Z')
    expect(updated.cycleAfter).toBe(0)
  })
})
