import { describe, expect, it } from 'vitest'
import { parseSettingsSection } from './settingsSections'

describe('settings section deep links', () => {
  it('accepts only known single-open accordion sections', () => {
    expect(parseSettingsSection('fsrs')).toBe('fsrs')
    expect(parseSettingsSection(['ai', 'data'])).toBe('ai')
    expect(parseSettingsSection('unknown')).toBeUndefined()
    expect(parseSettingsSection(undefined)).toBeUndefined()
  })
})
