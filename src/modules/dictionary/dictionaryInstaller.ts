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
    currentDictionary?: string
    currentShard?: string
    shardIndex?: number
    shardTotal?: number
    batchesWritten?: number
    failedDictionaries?: number
  }
}

interface ResolvedDictionaryManifest {
  manifest: DictionaryManifest
  dictId: string
  dictionaryName: string
  baseUrl: string
}

const ENTRY_IMPORT_BATCH_SIZE = 800
const INDEX_IMPORT_BATCH_SIZE = 600
const MAX_INDEX_DERIVATION_ENTRY_COUNT = 120000
const PREFIX_TOKEN_MAX_LENGTH = 5

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

function buildMappedEntryId(dictId: string, originEntryId: string): string {
  return `${dictId}:${originEntryId}`
}

async function yieldToMainThread(): Promise<void> {
  await new Promise<void>((resolve) => {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => resolve())
      return
    }
    setTimeout(resolve, 0)
  })
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
  if (!trimmed) {
    return []
  }

  if (trimmed.startsWith('[')) {
    return JSON.parse(trimmed) as T[]
  }

  return trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T)
}

async function streamJsonRecords<T>(
  url: string,
  onRecord: (record: T) => Promise<void>,
): Promise<void> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`)
  }

  if (!response.body) {
    const content = await response.text()
    const records = parseJsonLines<T>(content)
    for (const record of records) {
      await onRecord(record)
    }
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let arrayMode = false
  let arrayPayload = ''
  let modeDetected = false

  const flushLines = async (final = false): Promise<void> => {
    let newLineIndex = buffer.indexOf('\n')
    while (newLineIndex !== -1) {
      const line = buffer.slice(0, newLineIndex).trim()
      buffer = buffer.slice(newLineIndex + 1)
      if (line) {
        await onRecord(JSON.parse(line) as T)
      }
      newLineIndex = buffer.indexOf('\n')
    }

    if (final) {
      const tail = buffer.trim()
      buffer = ''
      if (tail) {
        await onRecord(JSON.parse(tail) as T)
      }
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }

    const chunk = decoder.decode(value, { stream: true })
    if (!modeDetected) {
      const probe = `${buffer}${chunk}`.trimStart()
      if (probe.length > 0) {
        modeDetected = true
        arrayMode = probe.startsWith('[')
      }
    }

    if (arrayMode) {
      arrayPayload += chunk
      continue
    }

    buffer += chunk
    await flushLines(false)
  }

  const tail = decoder.decode()
  if (arrayMode) {
    const parsed = JSON.parse((arrayPayload + tail).trim()) as T[]
    for (const record of parsed) {
      await onRecord(record)
    }
    return
  }

  buffer += tail
  await flushLines(true)
}

async function forEachShardRecord<T>(
  shardUrl: string,
  shard: DictionaryShard,
  onRecord: (record: T) => Promise<void>,
): Promise<void> {
  // Hash verification requires full payload; use stream path otherwise.
  if (shard.sha256) {
    const content = await fetchText(shardUrl)
    const digest = await sha256Hex(content)
    if (digest !== shard.sha256) {
      throw new Error(`Checksum mismatch for ${shard.path}`)
    }
    const rows = parseJsonLines<T>(content)
    for (const row of rows) {
      await onRecord(row)
    }
    return
  }

  await streamJsonRecords<T>(shardUrl, onRecord)
}

function mapEntryRow(
  entry: DictionaryEntry,
  dictId: string,
  dictionaryName: string,
): DictionaryEntry {
  const originEntryId = entry.entryId
  return {
    ...entry,
    originEntryId,
    entryId: buildMappedEntryId(dictId, originEntryId),
    dictionaryId: dictId,
    dictionaryName,
    headwordLower: normalizeWord(entry.headwordLower || entry.headword),
  }
}

function normalizeIndexRow(row: DictionaryIndexRow, dictId: string): DictionaryIndexRow {
  return {
    token: normalizeWord(row.token),
    entryIds: [...new Set(row.entryIds.map((entryId) => buildMappedEntryId(dictId, entryId)))],
  }
}

function appendDerivedIndex(tokenMap: Map<string, Set<string>>, entries: DictionaryEntry[]): void {
  for (const entry of entries) {
    const tokens = buildPrefixTokens(entry.headword, PREFIX_TOKEN_MAX_LENGTH)
    for (const token of tokens) {
      const bucket = tokenMap.get(token) ?? new Set<string>()
      bucket.add(entry.entryId)
      tokenMap.set(token, bucket)
    }
  }
}

function mapInstallError(error: unknown): Error {
  const reason = error instanceof Error ? error : new Error(String(error))
  const message = reason.message || String(reason)
  if (message.includes('QuotaExceededError')) {
    return new Error('存储空间不足：iPhone Safari 可能限制离线容量，请清理空间后重试。')
  }
  if (message.includes('AbortError')) {
    return new Error('安装被中断：请保持页面常亮、关闭低电量模式并重试。')
  }
  return reason
}

export async function fetchDictionaryManifest(manifestUrl: string): Promise<DictionaryManifest> {
  const manifestRaw = await fetchText(manifestUrl)
  return JSON.parse(manifestRaw) as DictionaryManifest
}

async function resolveManifest(
  manifestUrl: string,
  dictionaryIndex: number,
): Promise<ResolvedDictionaryManifest> {
  const absoluteManifestUrl = toAbsoluteUrl(manifestUrl)
  const manifest = await fetchDictionaryManifest(absoluteManifestUrl)
  const dictId = normalizeDictionaryId(manifest.id ?? manifest.name ?? `dict-${dictionaryIndex + 1}`)
  const dictionaryName = manifest.name ?? manifest.source ?? `词典 ${dictionaryIndex + 1}`
  const baseUrl = new URL('.', absoluteManifestUrl).toString()

  return { manifest, dictId, dictionaryName, baseUrl }
}

async function importSingleDictionary(
  dictionary: ResolvedDictionaryManifest,
  startedAt: number,
  onProgress?: (progress: InstallProgress) => void,
): Promise<{ importedEntries: number; importedIndices: number; batchesWritten: number }> {
  const { manifest, dictId, dictionaryName, baseUrl } = dictionary
  let importedEntries = 0
  let importedIndices = 0
  let batchesWritten = 0
  const hasRemoteIndices = Boolean(manifest.indices && manifest.indices.length > 0)
  const shouldDeriveIndex = !hasRemoteIndices && manifest.entryCount <= MAX_INDEX_DERIVATION_ENTRY_COUNT
  const tokenMap = shouldDeriveIndex ? new Map<string, Set<string>>() : null

  const entryBatch: DictionaryEntry[] = []
  const flushEntryBatch = async (
    shardPath: string,
    shardIndex: number,
    shardTotal: number,
  ): Promise<void> => {
    if (entryBatch.length === 0) {
      return
    }

    const chunk = entryBatch.splice(0, entryBatch.length)
    await db.dictionaryEntries.bulkPut(chunk)
    importedEntries += chunk.length
    batchesWritten += 1
    if (tokenMap) {
      appendDerivedIndex(tokenMap, chunk)
    }

    onProgress?.({
      stage: 'import',
      ratio: manifest.entryCount > 0 ? Math.min(importedEntries / manifest.entryCount, 1) : 1,
      message: `写入词条批次 #${batchesWritten} (${chunk.length} 条)`,
      stats: {
        entries: importedEntries,
        indices: importedIndices,
        elapsedMs: Math.round(performance.now() - startedAt),
        currentDictionary: dictionaryName,
        currentShard: shardPath,
        shardIndex,
        shardTotal,
        batchesWritten,
      },
    })

    await yieldToMainThread()
  }

  for (const [entryShardIndex, shard] of manifest.entries.entries()) {
    const shardIndex = entryShardIndex + 1
    const url = resolveUrl(baseUrl, shard.path)
    onProgress?.({
      stage: 'download-entries',
      ratio: entryShardIndex / Math.max(manifest.entries.length, 1),
      message: `读取词条分片 ${shardIndex} / ${manifest.entries.length}`,
      stats: {
        entries: importedEntries,
        indices: importedIndices,
        elapsedMs: Math.round(performance.now() - startedAt),
        currentDictionary: dictionaryName,
        currentShard: shard.path,
        shardIndex,
        shardTotal: manifest.entries.length,
        batchesWritten,
      },
    })

    await forEachShardRecord<DictionaryEntry>(url, shard, async (row) => {
      entryBatch.push(mapEntryRow(row, dictId, dictionaryName))
      if (entryBatch.length >= ENTRY_IMPORT_BATCH_SIZE) {
        await flushEntryBatch(shard.path, shardIndex, manifest.entries.length)
      }
    })

    await flushEntryBatch(shard.path, shardIndex, manifest.entries.length)
    await yieldToMainThread()
  }

  if (hasRemoteIndices) {
    const indexShards = manifest.indices ?? []
    const indexBatch: DictionaryIndexRow[] = []
    const flushIndexBatch = async (
      shardPath: string,
      shardIndex: number,
      shardTotal: number,
    ): Promise<void> => {
      if (indexBatch.length === 0) {
        return
      }

      const chunk = indexBatch.splice(0, indexBatch.length)
      await db.dictionaryIndex.bulkPut(chunk)
      importedIndices += chunk.length
      batchesWritten += 1

      onProgress?.({
        stage: 'download-indices',
        ratio: shardTotal > 0 ? shardIndex / shardTotal : 1,
        message: `写入索引批次 #${batchesWritten} (${chunk.length} 条)`,
        stats: {
          entries: importedEntries,
          indices: importedIndices,
          elapsedMs: Math.round(performance.now() - startedAt),
          currentDictionary: dictionaryName,
          currentShard: shardPath,
          shardIndex,
          shardTotal,
          batchesWritten,
        },
      })

      await yieldToMainThread()
    }

    for (const [indexShardIdx, shard] of indexShards.entries()) {
      const shardIndex = indexShardIdx + 1
      const url = resolveUrl(baseUrl, shard.path)
      await forEachShardRecord<DictionaryIndexRow>(url, shard, async (row) => {
        indexBatch.push(normalizeIndexRow(row, dictId))
        if (indexBatch.length >= INDEX_IMPORT_BATCH_SIZE) {
          await flushIndexBatch(shard.path, shardIndex, indexShards.length)
        }
      })

      await flushIndexBatch(shard.path, shardIndex, indexShards.length)
      await yieldToMainThread()
    }
  } else if (tokenMap && tokenMap.size > 0) {
    const derivedRows = [...tokenMap.entries()].map(([token, entryIds]) => ({ token, entryIds: [...entryIds] }))
    const batch: DictionaryIndexRow[] = []
    for (const row of derivedRows) {
      batch.push(row)
      if (batch.length >= INDEX_IMPORT_BATCH_SIZE) {
        const chunk = batch.splice(0, batch.length)
        await db.dictionaryIndex.bulkPut(chunk)
        importedIndices += chunk.length
        batchesWritten += 1
        await yieldToMainThread()
      }
    }
    if (batch.length > 0) {
      await db.dictionaryIndex.bulkPut(batch)
      importedIndices += batch.length
      batchesWritten += 1
      await yieldToMainThread()
    }
  }

  return { importedEntries, importedIndices, batchesWritten }
}

export async function installDictionaryBundle(
  manifestUrls: string[],
  onProgress?: (progress: InstallProgress) => void,
): Promise<DictionaryMeta> {
  const startedAt = performance.now()
  if (manifestUrls.length === 0) {
    throw new Error('No dictionary manifests provided')
  }

  const resolvedDictionaries: ResolvedDictionaryManifest[] = []
  const failedDictionaries: string[] = []

  for (const [index, manifestUrl] of manifestUrls.entries()) {
    onProgress?.({
      stage: 'fetch-manifest',
      ratio: (index + 1) / manifestUrls.length,
      message: `加载词典配置 ${index + 1} / ${manifestUrls.length}`,
      stats: {
        dictionaries: manifestUrls.length,
        elapsedMs: Math.round(performance.now() - startedAt),
        failedDictionaries: failedDictionaries.length,
      },
    })

    try {
      const resolved = await resolveManifest(manifestUrl, index)
      resolvedDictionaries.push(resolved)
    } catch (error) {
      const reason = mapInstallError(error)
      failedDictionaries.push(`${manifestUrl} -> ${reason.message}`)
    }
  }

  if (resolvedDictionaries.length === 0) {
    throw new Error(`All dictionaries failed to install: ${failedDictionaries.join(' || ')}`)
  }

  await db.transaction('rw', db.dictionaryMeta, db.dictionaryEntries, db.dictionaryIndex, async () => {
    await db.dictionaryEntries.clear()
    await db.dictionaryIndex.clear()
    await db.dictionaryMeta.clear()
  })
  await yieldToMainThread()

  const importedManifestList: ResolvedDictionaryManifest[] = []
  let totalImportedEntries = 0
  let totalImportedIndices = 0
  let totalBatchesWritten = 0

  for (const [index, dictionary] of resolvedDictionaries.entries()) {
    try {
      const result = await importSingleDictionary(dictionary, startedAt, (progress) => {
        onProgress?.({
          stage: progress.stage,
          ratio: (index + progress.ratio) / resolvedDictionaries.length,
          message: `[${index + 1}/${resolvedDictionaries.length}] ${progress.message}`,
          stats: {
            entries: totalImportedEntries + (progress.stats?.entries ?? 0),
            indices: totalImportedIndices + (progress.stats?.indices ?? 0),
            dictionaries: resolvedDictionaries.length,
            elapsedMs: Math.round(performance.now() - startedAt),
            currentDictionary: progress.stats?.currentDictionary,
            currentShard: progress.stats?.currentShard,
            shardIndex: progress.stats?.shardIndex,
            shardTotal: progress.stats?.shardTotal,
            batchesWritten: totalBatchesWritten + (progress.stats?.batchesWritten ?? 0),
            failedDictionaries: failedDictionaries.length,
          },
        })
      })

      importedManifestList.push(dictionary)
      totalImportedEntries += result.importedEntries
      totalImportedIndices += result.importedIndices
      totalBatchesWritten += result.batchesWritten
    } catch (error) {
      const reason = mapInstallError(error)
      failedDictionaries.push(`${dictionary.dictionaryName} -> ${reason.message}`)
    }
  }

  if (importedManifestList.length === 0) {
    throw new Error(`All dictionaries failed to import: ${failedDictionaries.join(' || ')}`)
  }

  const installedAt = new Date().toISOString()
  const meta: DictionaryMeta = {
    id: 'active',
    version: importedManifestList.map((item) => item.manifest.version).join(' + '),
    source: importedManifestList.map((item) => item.manifest.source).join(' | '),
    checksum: importedManifestList.map((item) => item.manifest.checksum).filter(Boolean).join('|') || undefined,
    installedAt,
    locale: importedManifestList.map((item) => item.manifest.locale).join(', '),
    entryCount: totalImportedEntries,
  }
  await db.dictionaryMeta.put(meta)
  await yieldToMainThread()

  const warningSuffix =
    failedDictionaries.length > 0
      ? `；跳过 ${failedDictionaries.length} 个词典：${failedDictionaries.slice(0, 2).join(' | ')}`
      : ''

  onProgress?.({
    stage: 'completed',
    ratio: 1,
    message: `词典安装完成${warningSuffix}`,
    stats: {
      entries: totalImportedEntries,
      indices: totalImportedIndices,
      dictionaries: importedManifestList.length,
      elapsedMs: Math.round(performance.now() - startedAt),
      batchesWritten: totalBatchesWritten,
      failedDictionaries: failedDictionaries.length,
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
