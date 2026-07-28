import dayjs from 'dayjs'
import { describe, expect, it } from 'vitest'
import { computeNextReviewAt, computeNextReviewState, REVIEW_INTERVAL_DAYS } from './scheduler'
import { cardToReviewState, migrateLegacyReviewState, previewFsrsReviews, scheduleFsrsReview } from './scheduler'

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

  it('offers four date-level FSRS outcomes without same-session minute steps', () => {
    const now = new Date('2026-07-13T08:00:00.000Z')
    const state = {
      wordId: 'fsrs-new', cycle: 0, nextReviewAt: now.toISOString(), successCount: 0,
      lapseCount: 0, totalReviews: 0,
    }
    const preview = previewFsrsReviews(state, now)
    expect(preview.again.card.due.getTime()).toBeGreaterThan(now.getTime())
    expect(preview.hard.card.due.getTime()).toBeGreaterThan(now.getTime())
    expect(preview.good.card.state).toBe(2)
    expect(preview.easy.card.due.getTime()).toBeGreaterThanOrEqual(preview.good.card.due.getTime())
    expect(Object.keys(preview)).toEqual(['again', 'hard', 'good', 'easy'])
  })

  it('replays legacy remember/forget logs into an FSRS card idempotently', () => {
    const legacy = {
      wordId: 'legacy', cycle: 2, nextReviewAt: '2026-07-10T00:00:00.000Z', successCount: 1,
      lapseCount: 1, totalReviews: 2,
    }
    const logs = [
      { wordId: 'legacy', reviewedAt: '2026-07-01T00:00:00.000Z', rating: 'remember' as const, cycleBefore: 0, cycleAfter: 1, nextReviewAtBefore: '2026-07-01T00:00:00.000Z', nextReviewAtAfter: '2026-07-02T00:00:00.000Z' },
      { wordId: 'legacy', reviewedAt: '2026-07-02T00:00:00.000Z', rating: 'forget' as const, cycleBefore: 1, cycleAfter: 0, nextReviewAtBefore: '2026-07-02T00:00:00.000Z', nextReviewAtAfter: '2026-07-02T00:00:00.000Z' },
    ]
    const migrated = migrateLegacyReviewState(legacy, logs, '2026-07-01T00:00:00.000Z')
    expect(migrated.schedulerVersion).toBe('fsrs-5')
    expect(migrated.reps).toBe(2)
    expect(migrateLegacyReviewState(migrated, logs, legacy.nextReviewAt)).toEqual(migrated)
    const next = scheduleFsrsReview(migrated, 'hard', new Date('2026-07-03T00:00:00.000Z'))
    expect(cardToReviewState('legacy', next.card, migrated).difficulty).toBeGreaterThan(0)
  })
})
