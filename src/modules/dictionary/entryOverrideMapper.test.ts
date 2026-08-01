import { describe, expect, it } from 'vitest'
import type { AiOverrideRecord, DictionaryEntry } from '../../types/models'
import { applyAiOverrideToEntryView } from './entryOverrideMapper'

const baseEntry: DictionaryEntry = {
  entryId: 'default:run',
  headword: 'run',
  headwordLower: 'run',
  posList: ['verb'],
  sensesJson: '["跑"]',
  examplesJson: '["EN: I run. | ZH: 我跑步。"]',
  usageJson: '["run fast"]',
  synonymsJson: '["sprint"]',
  antonymsJson: '["walk"]',
}

describe('entry override mapper', () => {
  it('replaces definition fields when mode is replace', () => {
    const override: AiOverrideRecord = {
      entryId: 'default:run',
      mode: 'replace',
      aiSensesJson: '["verb: 跑；奔跑"]',
      aiExamplesJson: '["EN: She runs daily. | ZH: 她每天跑步。"]',
      aiUsageJson: '["run into: 偶遇"]',
      aiSynonymsJson: '["dash"]',
      aiAntonymsJson: '["stand still"]',
      provider: 'deepseek',
      model: 'deepseek-chat',
      promptVersion: 'v1',
      createdAt: '2026-02-28T00:00:00.000Z',
    }

    const mapped = applyAiOverrideToEntryView(baseEntry, override)
    expect(mapped.sensesJson).toContain('奔跑')
    expect(mapped.aiEnhanceMode).toBe('replace')
    expect(mapped.synonymsJson).toBe('["dash"]')
    expect(mapped.antonymsJson).toBe('["stand still"]')
  })

  it('appends definition fields when mode is add', () => {
    const override: AiOverrideRecord = {
      entryId: 'default:run',
      mode: 'add',
      aiSensesJson: '["verb: 跑；奔跑"]',
      aiExamplesJson: '["EN: She runs daily. | ZH: 她每天跑步。"]',
      aiUsageJson: '["run into: 偶遇"]',
      aiSynonymsJson: '["sprint","dash"]',
      aiAntonymsJson: '["walk"]',
      provider: 'deepseek',
      model: 'deepseek-chat',
      promptVersion: 'v1',
      createdAt: '2026-02-28T00:00:00.000Z',
    }

    const mapped = applyAiOverrideToEntryView(baseEntry, override)
    expect(mapped.sensesJson).toContain('跑')
    expect(mapped.sensesJson).toContain('奔跑')
    expect(mapped.aiEnhanceMode).toBe('add')
    expect(JSON.parse(mapped.synonymsJson ?? '[]')).toEqual(['sprint', 'dash'])
    expect(JSON.parse(mapped.antonymsJson ?? '[]')).toEqual(['walk'])
  })

  it('treats missing relation fields in legacy overrides as empty arrays', () => {
    const mapped = applyAiOverrideToEntryView(baseEntry, {
      entryId: 'default:run', mode: 'replace', aiSensesJson: '["跑"]', aiExamplesJson: '[]', aiUsageJson: '[]',
      provider: 'deepseek', model: 'legacy', promptVersion: 'v1', createdAt: '2026-02-28T00:00:00.000Z',
    })
    expect(mapped.synonymsJson).toBe('[]')
    expect(mapped.antonymsJson).toBe('[]')
  })
})
