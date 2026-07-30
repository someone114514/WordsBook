import { describe, expect, it } from 'vitest'
import {
  buildUnitReadingBatches,
  extractRecoveryReadingBatches,
  findReadingBatchForUnit,
  mergeReadingPlanWithRecovery,
  parseReadingBatchesJson,
} from './readingBatchPlan'

function units(sizes: number[]): string {
  let cursor = 0
  return JSON.stringify(sizes.map((size, index) => ({
    unitId: `u${index + 1}`,
    wordIds: Array.from({ length: size }, () => `w${++cursor}`),
  })))
}

describe('reading batch plan', () => {
  it('combines adjacent five-word card units into ten-word articles', () => {
    expect(buildUnitReadingBatches(units([5, 5, 5, 5])).map((batch) => batch.length))
      .toEqual([10, 10])
  })

  it('keeps whole learning units and never exceeds twelve targets', () => {
    expect(buildUnitReadingBatches(units([8, 4, 6, 6])).map((batch) => batch.length))
      .toEqual([12, 12])
  })

  it('can move an incompletely covered unit to a later carry-forward batch', () => {
    const batches = parseReadingBatchesJson(JSON.stringify([
      ['w1', 'w2', 'w3', 'w4'],
      ['w4', 'w5', 'w6'],
    ]))
    expect(findReadingBatchForUnit(batches, ['w3', 'w4', 'w5'], 0)).toBe(1)
  })

  it('reattaches an omitted-word recovery when unit membership changes', () => {
    const cached = [
      ['w1', 'w2', 'w3', 'w4', 'w5'],
      ['w2'],
      ['w6', 'w7', 'w8', 'w9', 'w10'],
    ]
    const planned = [
      ['w1', 'w2', 'w3', 'w4', 'w5'],
      ['w6', 'w7', 'w8', 'w9', 'w10'],
      ['w11', 'w12', 'w13', 'w14', 'w15'],
    ]
    const merged = mergeReadingPlanWithRecovery(planned, cached)

    expect(merged).toEqual([planned[0], ['w2'], planned[1], planned[2]])
    expect(extractRecoveryReadingBatches(merged)).toEqual([{ sourceIndex: 1, wordIds: ['w2'] }])
  })
})
