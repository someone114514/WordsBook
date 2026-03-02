import type { AiOverrideRecord, DictionaryEntry } from '../../types/models'
import { getAiOverrideMap } from './aiDefinitionService'

function parseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed.map((item) => String(item)).filter((item) => item.length > 0)
  } catch {
    return []
  }
}

function toJsonArray(items: string[]): string {
  return JSON.stringify([...new Set(items.map((item) => item.trim()).filter((item) => item.length > 0))], null, 0)
}

export function applyAiOverrideToEntryView(
  entry: DictionaryEntry,
  override: AiOverrideRecord | undefined,
): DictionaryEntry {
  if (!override) {
    return {
      ...entry,
      aiEnhanced: false,
      aiEnhanceMode: undefined,
      aiUpdatedAt: undefined,
    }
  }

  if (override.mode === 'replace') {
    return {
      ...entry,
      sensesJson: override.aiSensesJson,
      examplesJson: override.aiExamplesJson,
      usageJson: override.aiUsageJson,
      aiEnhanced: true,
      aiEnhanceMode: 'replace',
      aiUpdatedAt: override.createdAt,
    }
  }

  return {
    ...entry,
    sensesJson: toJsonArray([...parseJsonArray(entry.sensesJson), ...parseJsonArray(override.aiSensesJson)]),
    examplesJson: toJsonArray([
      ...parseJsonArray(entry.examplesJson),
      ...parseJsonArray(override.aiExamplesJson),
    ]),
    usageJson: toJsonArray([...parseJsonArray(entry.usageJson), ...parseJsonArray(override.aiUsageJson)]),
    aiEnhanced: true,
    aiEnhanceMode: 'add',
    aiUpdatedAt: override.createdAt,
  }
}

export async function applyAiOverrides(entries: DictionaryEntry[]): Promise<DictionaryEntry[]> {
  if (entries.length === 0) {
    return []
  }

  const overrideMap = await getAiOverrideMap(entries.map((entry) => entry.entryId))
  return entries.map((entry) => applyAiOverrideToEntryView(entry, overrideMap.get(entry.entryId)))
}
