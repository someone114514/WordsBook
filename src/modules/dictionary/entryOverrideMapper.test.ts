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
}

describe('entry override mapper', () => {
  it('replaces definition fields when mode is replace', () => {
    const override: AiOverrideRecord = {
      entryId: 'default:run',
      mode: 'replace',
      aiSensesJson: '["verb: 跑；奔跑"]',
      aiExamplesJson: '["EN: She runs daily. | ZH: 她每天跑步。"]',
      aiUsageJson: '["run into: 偶遇"]',
      provider: 'deepseek',
      model: 'deepseek-chat',
      promptVersion: 'v1',
      createdAt: '2026-02-28T00:00:00.000Z',
    }

    const mapped = applyAiOverrideToEntryView(baseEntry, override)
    expect(mapped.sensesJson).toContain('奔跑')
    expect(mapped.aiEnhanceMode).toBe('replace')
  })

  it('appends definition fields when mode is add', () => {
    const override: AiOverrideRecord = {
      entryId: 'default:run',
      mode: 'add',
      aiSensesJson: '["verb: 跑；奔跑"]',
      aiExamplesJson: '["EN: She runs daily. | ZH: 她每天跑步。"]',
      aiUsageJson: '["run into: 偶遇"]',
      provider: 'deepseek',
      model: 'deepseek-chat',
      promptVersion: 'v1',
      createdAt: '2026-02-28T00:00:00.000Z',
    }

    const mapped = applyAiOverrideToEntryView(baseEntry, override)
    expect(mapped.sensesJson).toContain('跑')
    expect(mapped.sensesJson).toContain('奔跑')
    expect(mapped.aiEnhanceMode).toBe('add')
  })
})
