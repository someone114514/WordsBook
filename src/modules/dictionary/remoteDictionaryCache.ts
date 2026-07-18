import type { DictionaryEntry } from '../../types/models'
import { normalizeWord, toLemmaCandidates } from './search'

const BASE_URL = import.meta.env.BASE_URL || '/'
const MANIFEST_URL = `${BASE_URL}dictionaries/ecdict-buckets/manifest.json`
const CACHE_NAME = 'wordsbook-ecdict-full-v1'
let paused = false
const bucketMemory = new Map<string, DictionaryEntry[]>()

interface BucketManifest {
  id: string
  version: string
  entryCount: number
  buckets: Array<{ prefix: string; path: string; count: number; size: number; sha256: string; contentSha256?: string }>
}

async function manifest(): Promise<BucketManifest> {
  const response = await fetch(MANIFEST_URL)
  if (!response.ok) throw new Error(`完整词典清单下载失败（HTTP ${response.status}）`)
  return response.json() as Promise<BucketManifest>
}

async function sha256(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

async function matchesBucketHash(buffer: ArrayBuffer, expectedSha: string, expectedContentSha?: string): Promise<boolean> {
  const bytes = new Uint8Array(buffer)
  const expected = bytes[0] === 0x1f && bytes[1] === 0x8b ? expectedSha : expectedContentSha
  return Boolean(expected && await sha256(buffer) === expected)
}

async function bucketBuffer(url: string, expectedSha: string, expectedContentSha?: string): Promise<ArrayBuffer> {
  const cache = await caches.open(CACHE_NAME)
  const cached = await cache.match(url)
  if (cached) {
    const cachedBuffer = await cached.arrayBuffer()
    if (await matchesBucketHash(cachedBuffer, expectedSha, expectedContentSha)) return cachedBuffer
    await cache.delete(url)
  }
  const response = await fetch(url, { cache: 'reload' })
  if (!response.ok) throw new Error(`完整词典分桶下载失败（HTTP ${response.status}）`)
  const clone = response.clone()
  const buffer = await response.arrayBuffer()
  if (!await matchesBucketHash(buffer, expectedSha, expectedContentSha)) throw new Error('完整词典分桶校验失败，请重试')
  await cache.put(url, clone)
  return buffer
}

async function decodeGzip(buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer)
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return new TextDecoder().decode(buffer)
  if (typeof DecompressionStream === 'undefined') throw new Error('当前浏览器不支持 gzip 词典包')
  return new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
}

function mapEntry(entry: DictionaryEntry): DictionaryEntry {
  return { ...entry, dictionaryId: 'ecdict-full', dictionaryName: 'ECDICT 完整词典' }
}

export async function lookupRemoteDictionary(query: string): Promise<{ exact: DictionaryEntry[]; lemma: DictionaryEntry[]; prefix: DictionaryEntry[] }> {
  const normalized = normalizeWord(query)
  if (!normalized) return { exact: [], lemma: [], prefix: [] }
  const data = await manifest()
  const bucket = data.buckets.find((row) => row.prefix === normalized[0]) ?? data.buckets.find((row) => row.prefix === '_')
  if (!bucket) return { exact: [], lemma: [], prefix: [] }
  const url = new URL(bucket.path, new URL(MANIFEST_URL, window.location.origin)).toString()
  let candidates = bucketMemory.get(bucket.prefix)
  if (!candidates) {
    const raw = await decodeGzip(await bucketBuffer(url, bucket.sha256, bucket.contentSha256))
    candidates = raw.split('\n').filter(Boolean).map((line) => mapEntry(JSON.parse(line) as DictionaryEntry))
    if (bucketMemory.size >= 2) bucketMemory.delete(bucketMemory.keys().next().value as string)
    bucketMemory.set(bucket.prefix, candidates)
  }
  const lemmas = new Set(toLemmaCandidates(normalized))
  return {
    exact: candidates.filter((entry) => entry.headwordLower === normalized),
    lemma: candidates.filter((entry) => lemmas.has(entry.headwordLower)),
    prefix: candidates.filter((entry) => entry.headwordLower.startsWith(normalized)).slice(0, 24),
  }
}

export function pauseFullDictionaryCache(): void { paused = true }

export async function cacheFullDictionaryInBackground(onProgress?: (completed: number, total: number) => void): Promise<void> {
  paused = false
  if (!('caches' in window) || !navigator.onLine || (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return
  const data = await manifest()
  const cache = await caches.open(CACHE_NAME)
  let completed = 0
  for (const bucket of data.buckets) {
    if (paused) return
    const url = new URL(bucket.path, new URL(MANIFEST_URL, window.location.origin)).toString()
    if (await cache.match(url)) { completed += 1; onProgress?.(completed, data.buckets.length); continue }
    await bucketBuffer(url, bucket.sha256, bucket.contentSha256)
    completed += 1
    onProgress?.(completed, data.buckets.length)
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
  }
}
