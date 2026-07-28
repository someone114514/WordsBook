import { describe, expect, it } from 'vitest'
import type { ReviewLog } from '../../types/models'
import { buildFsrsOptimizationDataset } from './fsrsPersonalizationService'

function log(
  wordId: string,
  reviewedAt: string,
  rating: ReviewLog['rating'],
  source: ReviewLog['source'] = 'flashcard',
): ReviewLog {
  return {
    wordId,
    reviewedAt,
    rating,
    source,
    cycleBefore: 0,
    cycleAfter: 0,
    nextReviewAtBefore: reviewedAt,
    nextReviewAtAfter: reviewedAt,
  }
}

describe('FSRS personalization dataset', () => {
  it('keeps one canonical long-term grade per word/day and excludes context evidence', () => {
    const dataset = buildFsrsOptimizationDataset([
      log('w1', '2026-07-10T08:00:00.000Z', 'again'),
      log('w1', '2026-07-10T09:00:00.000Z', 'good'),
      log('w1', '2026-07-11T08:00:00.000Z', 'hard'),
      log('w1', '2026-07-12T08:00:00.000Z', 'easy', 'context'),
    ])

    expect(dataset.effectiveReviewCount).toBe(2)
    expect(dataset.items).toEqual([{
      wordId: 'w1',
      reviewedAt: '2026-07-11T08:00:00.000Z',
      reviews: [
        { rating: 1, deltaT: 0 },
        { rating: 2, deltaT: 1 },
      ],
    }])
    expect(dataset.canonicalLogsByWord.get('w1')?.map((row) => row.rating)).toEqual(['again', 'hard'])
  })

  it('normalizes legacy remember/forget ratings for optimizer compatibility', () => {
    const dataset = buildFsrsOptimizationDataset([
      log('w1', '2026-07-10T08:00:00.000Z', 'forget'),
      log('w1', '2026-07-12T08:00:00.000Z', 'remember'),
    ])

    expect(dataset.items[0]?.reviews).toEqual([
      { rating: 1, deltaT: 0 },
      { rating: 3, deltaT: 2 },
    ])
  })
})
