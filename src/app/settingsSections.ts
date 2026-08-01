export const SETTINGS_SECTIONS = ['dictionary', 'fsrs', 'ai', 'sync', 'data'] as const
export type SettingsSection = typeof SETTINGS_SECTIONS[number]

export function parseSettingsSection(value: unknown): SettingsSection | undefined {
  const normalized = Array.isArray(value) ? value[0] : value
  return typeof normalized === 'string' && SETTINGS_SECTIONS.includes(normalized as SettingsSection)
    ? normalized as SettingsSection
    : undefined
}
