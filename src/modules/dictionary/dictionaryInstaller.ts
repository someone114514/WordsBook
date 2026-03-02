import { db } from '../../db/database'
import type { DictionaryEntry, DictionaryIndexRow, DictionaryMeta } from '../../types/models'
import { buildPrefixTokens, normalizeWord } from './search'

export interface DictionaryShard {
  path: string
  size?: number
  sha256?: string
}

export interface DictionaryManifest {
  id?: string
  name?: string
  version: string
  locale: string
  source: string
  publishedAt: string
  checksum?: string
  entryCount: number
  entries: DictionaryShard[]
  indices?: DictionaryShard[]
}

export type InstallStage =
  | 'fetch-manifest'
  | 'download-entries'
  | 'download-indices'
  | 'verify'
  | 'import'
  | 'completed'

export interface InstallProgress {
  stage: InstallStage
  ratio: number
  message: string
  stats?: {
    entries?: number
    indices?: number
    dictionaries?: number
    elapsedMs?: number
  }
}

interface LoadedDictionaryPackage {
  manifest: DictionaryManifest
  entries: DictionaryEntry[]
  indices: DictionaryIndexRow[]
}

const ENTRY_IMPORT_BATCH_SIZE = 10000
const INDEX_IMPORT_BATCH_SIZE = 5000

function resolveUrl(baseUrl: string, target: string): string {
  return new URL(target, baseUrl).toString()
}

function toAbsoluteUrl(input: string): string {
  if (/^https?:\/\//.test(input)) {
    return input
  }

  if (typeof window !== 'undefined') {
    return new URL(input, window.location.origin).toString()
  }

  return input
}

function normalizeDictionaryId(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

async function sha256Hex(content: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(content)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(hashBuffer)].map((item) => item.toString(16).padStart(2, '0')).join('')
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`)
  }

  return response.text()
}

function parseJsonLines<T>(raw: string): T[] {
  const trimmed = raw.trim()
  if (trimmed.startsWith('[')) {
    return JSON.parse(trimmed) as T[]
  }

  return trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T)
}

function deriveIndex(entries: DictionaryEntry[]): DictionaryIndexRow[] {
  const tokenMap = new Map<string, Set<string>>()

  for (const entry of entries) {
    for (const token of buildPrefixTokens(entry.headword)) {
      const bucket = tokenMap.get(token) ?? new Set<string>()
      bucket.add(entry.entryId)
      tokenMap.set(token, bucket)
    }
  }

  return [...tokenMap.entries()].map(([token, entryIds]) => ({ token, entryIds: [...entryIds] }))
}

function mergeIndexRows(indexRows: DictionaryIndexRow[]): DictionaryIndexRow[] {
  const merged = new Map<string, Set<string>>()

  for (const row of indexRows) {
    const set = merged.get(row.token) ?? new Set<string>()
    for (const entryId of row.entryIds) {
      set.add(entryId)
    }
    merged.set(row.token, set)
  }

  return [...merged.entries()].map(([token, entryIds]) => ({ token, entryIds: [...entryIds] }))
}

async function downloadShards<T>(
  shards: DictionaryShard[],
  baseUrl: string,
  stage: InstallStage,
  onProgress?: (progress: InstallProgress) => void,
): Promise<T[]> {
  const collected: T[] = []

  for (const [index, shard] of shards.entries()) {
    const url = resolveUrl(baseUrl, shard.path)
    const content = await fetchText(url)

    if (shard.sha256) {
      onProgress?.({
        stage: 'verify',
        ratio: (index + 1) / shards.length,
        message: `Verifying ${shard.path}`,
      })

      const digest = await sha256Hex(content)
      if (digest !== shard.sha256) {
        throw new Error(`Checksum mismatch for ${shard.path}`)
      }
    }

    const rows = parseJsonLines<T>(content)
    collected.push(...rows)

    onProgress?.({
      stage,
      ratio: (index + 1) / shards.length,
      message: `Loaded ${shard.path}`,
    })
  }

  return collected
}

export async function fetchDictionaryManifest(manifestUrl: string): Promise<DictionaryManifest> {
  const manifestRaw = await fetchText(manifestUrl)
  return JSON.parse(manifestRaw) as DictionaryManifest
}

async function loadDictionaryPackage(
  manifestUrl: string,
  dictionaryIndex: number,
  onProgress?: (progress: InstallProgress) => void,
): Promise<LoadedDictionaryPackage> {
  const absoluteManifestUrl = toAbsoluteUrl(manifestUrl)
  const manifest = await fetchDictionaryManifest(absoluteManifestUrl)
  const baseUrl = new URL('.', absoluteManifestUrl).toString()

  const rawEntries = await downloadShards<DictionaryEntry>(
    manifest.entries,
    baseUrl,
    'download-entries',
    onProgress,
  )

  const dictId = normalizeDictionaryId(manifest.id ?? manifest.name ?? `dict-${dictionaryIndex + 1}`)
  const dictionaryName = manifest.name ?? manifest.source ?? `词典 ${dictionaryIndex + 1}`

  const idMap = new Map<string, string>()
  const entries = rawEntries.map((entry) => {
    const originEntryId = entry.entryId
    const mappedEntryId = `${dictId}:${originEntryId}`
    idMap.set(originEntryId, mappedEntryId)

    return {
      ...entry,
      originEntryId,
      entryId: mappedEntryId,
      dictionaryId: dictId,
      dictionaryName,
      headwordLower: normalizeWord(entry.headwordLower || entry.headword),
    }
  })

  let indices: DictionaryIndexRow[] = []
  if (manifest.indices && manifest.indices.length > 0) {
    const rawIndexRows = await downloadShards<DictionaryIndexRow>(
      manifest.indices,
      baseUrl,
      'download-indices',
      onProgress,
    )

    indices = rawIndexRows.map((row) => ({
      token: normalizeWord(row.token),
      entryIds: [...new Set(row.entryIds.map((entryId) => idMap.get(entryId) ?? `${dictId}:${entryId}`))],
    }))
  } else {
    indices = deriveIndex(entries)
  }

  return {
    manifest,
    entries,
    indices,
  }
}

export async function installDictionaryBundle(
  manifestUrls: string[],
  onProgress?: (progress: InstallProgress) => void,
): Promise<DictionaryMeta> {
  const startedAt = performance.now()
  if (manifestUrls.length === 0) {
    throw new Error('No dictionary manifests provided')
  }

  const dictionaries: LoadedDictionaryPackage[] = []
  const failedDictionaries: string[] = []
  for (const [index, manifestUrl] of manifestUrls.entries()) {
    onProgress?.({
      stage: 'fetch-manifest',
      ratio: index / manifestUrls.length,
      message: `Loading dictionary ${index + 1} / ${manifestUrls.length}`,
    })

    try {
      const pkg = await loadDictionaryPackage(manifestUrl, index, (progress) => {
        onProgress?.({
          stage: progress.stage,
          ratio: (index + progress.ratio) / manifestUrls.length,
          message: `[${index + 1}/${manifestUrls.length}] ${progress.message}`,
          stats: {
            dictionaries: manifestUrls.length,
            elapsedMs: Math.round(performance.now() - startedAt),
          },
        })
      })

      dictionaries.push(pkg)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      failedDictionaries.push(`${manifestUrl} -> ${reason}`)
      onProgress?.({
        stage: 'fetch-manifest',
        ratio: (index + 1) / manifestUrls.length,
        message: `Skipped dictionary ${index + 1}: ${reason}`,
        stats: {
          dictionaries: manifestUrls.length,
          elapsedMs: Math.round(performance.now() - startedAt),
        },
      })
    }
  }

  if (dictionaries.length === 0) {
    throw new Error(`All dictionaries failed to install: ${failedDictionaries.join(' || ')}`)
  }

  const entries = dictionaries.flatMap((item) => item.entries)
  const mergedIndices = mergeIndexRows(dictionaries.flatMap((item) => item.indices))
  const totalImportItems = entries.length + mergedIndices.length + 1
  let importedItems = 0
  const reportImport = (message: string) => {
    const base = 0.95
    const span = 0.049
    const ratio = base + (importedItems / Math.max(totalImportItems, 1)) * span
    onProgress?.({
      stage: 'import',
      ratio: Math.min(ratio, 0.999),
      message,
      stats: {
        entries: entries.length,
        indices: mergedIndices.length,
        dictionaries: dictionaries.length,
        elapsedMs: Math.round(performance.now() - startedAt),
      },
    })
  }

  reportImport('Preparing merged dictionary import')

  const installedAt = new Date().toISOString()
  const meta: DictionaryMeta = {
    id: 'active',
    version: dictionaries.map((item) => item.manifest.version).join(' + '),
    source: dictionaries.map((item) => item.manifest.source).join(' | '),
    checksum: dictionaries.map((item) => item.manifest.checksum).filter(Boolean).join('|') || undefined,
    installedAt,
    locale: dictionaries.map((item) => item.manifest.locale).join(', '),
    entryCount: entries.length,
  }

  await db.transaction('rw', db.dictionaryMeta, db.dictionaryEntries, db.dictionaryIndex, async () => {
    await db.dictionaryEntries.clear()
    await db.dictionaryIndex.clear()

    for (let offset = 0; offset < entries.length; offset += ENTRY_IMPORT_BATCH_SIZE) {
      const chunk = entries.slice(offset, offset + ENTRY_IMPORT_BATCH_SIZE)
      await db.dictionaryEntries.bulkPut(chunk)
      importedItems += chunk.length
      reportImport(`Importing entries ${Math.min(offset + chunk.length, entries.length)} / ${entries.length}`)
    }

    for (let offset = 0; offset < mergedIndices.length; offset += INDEX_IMPORT_BATCH_SIZE) {
      const chunk = mergedIndices.slice(offset, offset + INDEX_IMPORT_BATCH_SIZE)
      await db.dictionaryIndex.bulkPut(chunk)
      importedItems += chunk.length
      reportImport(
        `Importing search indices ${Math.min(offset + chunk.length, mergedIndices.length)} / ${mergedIndices.length}`,
      )
    }

    await db.dictionaryMeta.put(meta)
    importedItems += 1
  })

  const warningSuffix =
    failedDictionaries.length > 0 ? ` (${failedDictionaries.length} dictionary failed and was skipped)` : ''
  onProgress?.({
    stage: 'completed',
    ratio: 1,
    message: `Dictionary bundle installed${warningSuffix}`,
    stats: {
      entries: entries.length,
      indices: mergedIndices.length,
      dictionaries: dictionaries.length,
      elapsedMs: Math.round(performance.now() - startedAt),
    },
  })

  return meta
}

export async function installDictionary(
  manifestUrl: string,
  onProgress?: (progress: InstallProgress) => void,
): Promise<DictionaryMeta> {
  return installDictionaryBundle([manifestUrl], onProgress)
}
