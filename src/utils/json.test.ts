import { describe, expect, it } from 'vitest'
import { parseJsonArray } from './json'

describe('json helpers', () => {
  it('splits actual and escaped line breaks inside dictionary arrays', () => {
    expect(parseJsonArray('["n. first\\n[化] second","third\\\\nfourth"]')).toEqual([
      'n. first',
      '[化] second',
      'third',
      'fourth',
    ])
  })

  it('returns an empty array for invalid payloads', () => {
    expect(parseJsonArray('not json')).toEqual([])
    expect(parseJsonArray('{"value":1}')).toEqual([])
  })
})
