import { describe, expect, it } from 'vitest'
import type { DictionaryEntry } from '../../types/models'
import { definitionLines, parseSenseRecords } from './senseRecords'

const entry: DictionaryEntry = {
  entryId: 'e1',
  headword: 'resilient',
  headwordLower: 'resilient',
  posList: ['adj'],
  sensesJson: '["adj: 有韧性的；able to recover quickly from difficulty"]',
  examplesJson: '["The resilient team recovered quickly."]',
  usageJson: '[]',
}

describe('structured bilingual senses', () => {
  it('derives a safe bilingual record from a legacy paired sense', () => {
    expect(parseSenseRecords(entry)[0]).toEqual(expect.objectContaining({
      pos: 'adj',
      glossZh: '有韧性的',
      definitionEn: 'able to recover quickly from difficulty',
    }))
  })

  it('uses Chinese first for B1 and English first for B2 in adaptive mode', () => {
    expect(definitionLines(entry, 'B1', 'adaptive')[0]).toMatchObject({
      primary: '有韧性的',
      secondary: 'able to recover quickly from difficulty',
    })
    expect(definitionLines(entry, 'B2', 'adaptive')[0]).toMatchObject({
      primary: 'able to recover quickly from difficulty',
      secondary: '有韧性的',
    })
  })

  it('turns escaped dictionary line breaks into separate definitions', () => {
    const escapedEntry: DictionaryEntry = {
      ...entry,
      usageJson: JSON.stringify(['sharp\\ns. lavishly elegant']),
      sensesJson: '[]',
    }

    expect(parseSenseRecords(escapedEntry).map((record) => record.definitionEn)).toEqual([
      'sharp',
      's. lavishly elegant',
    ])
  })
})
