import type { AppSettings, DictionaryEntry } from '../../types/models'

export interface PronunciationResult {
  success: boolean
  source: 'dictionary-audio' | 'remote-audio' | 'tts' | 'none'
  error?: string
}

export interface PronunciationOptions {
  rate?: number
  ttsEngine?: AppSettings['ttsEngine']
}

const dictionaryApiAudioCache = new Map<string, string | null>()
const preloadPromiseMap = new Map<string, Promise<boolean>>()
const preloadedUrlSet = new Set<string>()
const REMOTE_AUDIO_LOOKUP_TIMEOUT_MS = 1600
const AUDIO_PLAY_TIMEOUT_MS = 2800
const AUDIO_PRELOAD_TIMEOUT_MS = 1800

let activeAudio: HTMLAudioElement | null = null

export function stopActivePronunciation(): void {
  if (activeAudio) {
    activeAudio.pause()
    activeAudio.removeAttribute('src')
    activeAudio.load()
    activeAudio = null
  }

  if (typeof window !== 'undefined' && window.speechSynthesis) {
    window.speechSynthesis.cancel()
  }
}

function appBaseUrl(): string {
  return import.meta.env.BASE_URL || '/'
}

function getAudioUrl(audioKey: string): string {
  if (/^https?:\/\//.test(audioKey)) {
    return audioKey
  }

  const base = appBaseUrl()
  const normalizedKey = audioKey.replace(/^\/+/, '')
  if (normalizedKey.includes('/')) {
    return new URL(normalizedKey, window.location.origin + base).toString()
  }

  return new URL(`dictionaries/default/audio/${normalizedKey}`, window.location.origin + base).toString()
}

async function playAudioUrl(url: string): Promise<void> {
  stopActivePronunciation()

  await new Promise<void>((resolve, reject) => {
    const audio = new Audio()
    let settled = false
    let timeout = 0

    const cleanup = () => {
      window.clearTimeout(timeout)
      audio.onplaying = null
      audio.onerror = null
      audio.onstalled = null
      audio.onwaiting = null
    }

    const finish = (error?: Error) => {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      if (error) {
        if (activeAudio === audio) {
          activeAudio = null
        }
        audio.pause()
        audio.removeAttribute('src')
        audio.load()
        reject(error)
        return
      }

      activeAudio = audio
      resolve()
    }

    timeout = window.setTimeout(() => {
      finish(new Error('audio-play-timeout'))
    }, AUDIO_PLAY_TIMEOUT_MS)

    audio.preload = 'auto'
    audio.onplaying = () => finish()
    audio.onerror = () => finish(new Error('audio-load-error'))
    audio.onstalled = () => finish(new Error('audio-stalled'))
    activeAudio = audio
    audio.src = url
    audio.load()

    const playResult = audio.play()
    if (playResult) {
      playResult.then(() => finish()).catch((error: unknown) => {
        finish(error instanceof Error ? error : new Error(String(error)))
      })
    }
  })
}

async function preloadAudioUrl(url: string): Promise<boolean> {
  if (preloadedUrlSet.has(url)) {
    return true
  }

  const existing = preloadPromiseMap.get(url)
  if (existing) {
    return existing
  }

  const task = new Promise<boolean>((resolve) => {
    const audio = new Audio()
    let settled = false
    let timeout = 0

    const finish = (ok: boolean) => {
      if (settled) {
        return
      }
      settled = true
      window.clearTimeout(timeout)
      audio.onloadeddata = null
      audio.oncanplaythrough = null
      audio.onerror = null
      if (ok) {
        preloadedUrlSet.add(url)
      }
      resolve(ok)
    }

    audio.preload = 'auto'
    audio.onloadeddata = () => finish(true)
    audio.oncanplaythrough = () => finish(true)
    audio.onerror = () => finish(false)
    timeout = window.setTimeout(() => finish(false), AUDIO_PRELOAD_TIMEOUT_MS)
    audio.src = url
    audio.load()
  }).finally(() => {
    preloadPromiseMap.delete(url)
  })

  preloadPromiseMap.set(url, task)
  return task
}

function normalizeWordForDictionaryApi(word: string): string {
  return word.trim().toLowerCase().replace(/[^a-z'-]/g, '')
}

async function resolveDictionaryApiAudioUrl(word: string): Promise<string | null> {
  const normalized = normalizeWordForDictionaryApi(word)
  if (!normalized) {
    return null
  }

  if (dictionaryApiAudioCache.has(normalized)) {
    return dictionaryApiAudioCache.get(normalized) ?? null
  }

  try {
    const endpoint = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(normalized)}`
    const response = await fetchWithTimeout(endpoint, REMOTE_AUDIO_LOOKUP_TIMEOUT_MS)
    if (!response.ok) {
      dictionaryApiAudioCache.set(normalized, null)
      return null
    }

    const data = (await response.json()) as Array<{ phonetics?: Array<{ audio?: string }> }>
    for (const item of data) {
      for (const phonetic of item.phonetics ?? []) {
        const raw = (phonetic.audio || '').trim()
        if (!raw) {
          continue
        }

        const audioUrl = raw.startsWith('//') ? `https:${raw}` : raw
        if (/^https?:\/\//.test(audioUrl)) {
          dictionaryApiAudioCache.set(normalized, audioUrl)
          return audioUrl
        }
      }
    }
  } catch {
    // ignore and fallback
  }

  dictionaryApiAudioCache.set(normalized, null)
  return null
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    window.clearTimeout(timeout)
  }
}

function buildYoudaoTtsUrl(word: string): string | null {
  const query = word.trim()
  if (!query) {
    return null
  }

  return `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(query)}&type=2`
}

function buildGoogleTtsUrl(word: string): string | null {
  const query = word.trim()
  if (!query) {
    return null
  }

  return `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=${encodeURIComponent(query)}`
}

async function resolveRemoteAudioCandidates(
  word: string,
  ttsEngine: AppSettings['ttsEngine'],
): Promise<string[]> {
  const urls: string[] = []

  const append = (url: string | null | undefined) => {
    if (!url) {
      return
    }

    if (!urls.includes(url)) {
      urls.push(url)
    }
  }

  if (ttsEngine === 'dictionaryapi') {
    append(await resolveDictionaryApiAudioUrl(word))
  }

  if (ttsEngine === 'youdao') {
    append(buildYoudaoTtsUrl(word))
  }

  if (ttsEngine === 'google') {
    append(buildGoogleTtsUrl(word))
  }

  return urls
}

async function resolveAudioCandidatesForEntry(
  entry: DictionaryEntry,
  ttsEngine: AppSettings['ttsEngine'],
): Promise<Array<{ url: string; source: 'dictionary-audio' | 'remote-audio' }>> {
  const candidates: Array<{ url: string; source: 'dictionary-audio' | 'remote-audio' }> = []
  const seen = new Set<string>()

  const append = (url: string | null | undefined, source: 'dictionary-audio' | 'remote-audio') => {
    if (!url || seen.has(url)) {
      return
    }
    seen.add(url)
    candidates.push({ url, source })
  }

  if (entry.audioKey) {
    append(getAudioUrl(entry.audioKey), 'dictionary-audio')
  }

  if (ttsEngine !== 'browser') {
    const remoteUrls = await resolveRemoteAudioCandidates(entry.headword, ttsEngine)
    for (const url of remoteUrls) {
      append(url, 'remote-audio')
    }
  }

  return candidates
}

function speakFallback(text: string, rate = 1): boolean {
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    return false
  }

  if (activeAudio) {
    activeAudio.pause()
    activeAudio.removeAttribute('src')
    activeAudio.load()
    activeAudio = null
  }

  const utterance = new SpeechSynthesisUtterance(text)
  const voices = window.speechSynthesis.getVoices()
  const preferredVoice = voices.find((voice) => voice.lang.toLowerCase().startsWith('en')) ?? voices[0]

  if (preferredVoice) {
    utterance.voice = preferredVoice
    utterance.lang = preferredVoice.lang
  } else {
    utterance.lang = 'en-US'
  }

  utterance.rate = rate
  window.speechSynthesis.cancel()
  window.speechSynthesis.resume()
  window.speechSynthesis.speak(utterance)
  return true
}

function normalizeOptions(options?: number | PronunciationOptions): Required<PronunciationOptions> {
  if (typeof options === 'number') {
    return { rate: options, ttsEngine: 'auto' }
  }

  return {
    rate: options?.rate ?? 1,
    ttsEngine: options?.ttsEngine ?? 'auto',
  }
}

export async function playEntryPronunciation(
  entry: DictionaryEntry,
  options?: number | PronunciationOptions,
): Promise<PronunciationResult> {
  if (typeof window === 'undefined') {
    return { success: false, source: 'none', error: 'not-in-browser' }
  }

  const normalized = normalizeOptions(options)
  const candidates = await resolveAudioCandidatesForEntry(entry, normalized.ttsEngine)
  for (const candidate of candidates) {
    try {
      await playAudioUrl(candidate.url)
      return { success: true, source: candidate.source }
    } catch {
      // try next source
    }
  }

  if (speakFallback(entry.headword, normalized.rate)) {
    return { success: true, source: 'tts' }
  }

  return { success: false, source: 'none', error: 'no-audio-source' }
}

export async function preloadEntryPronunciation(
  entry: DictionaryEntry,
  options?: PronunciationOptions,
): Promise<PronunciationResult> {
  if (typeof window === 'undefined') {
    return { success: false, source: 'none', error: 'not-in-browser' }
  }

  const normalized = normalizeOptions(options)
  const candidates = await resolveAudioCandidatesForEntry(entry, normalized.ttsEngine)
  for (const candidate of candidates) {
    const ok = await preloadAudioUrl(candidate.url)
    if (ok) {
      return { success: true, source: candidate.source }
    }
  }

  return { success: false, source: 'none', error: 'no-preload-source' }
}

export async function preloadPronunciationQueue(
  entries: DictionaryEntry[],
  options?: PronunciationOptions & { batchSize?: number },
): Promise<void> {
  if (entries.length === 0) {
    return
  }

  const batchSize = Math.max(1, options?.batchSize ?? 3)
  for (let offset = 0; offset < entries.length; offset += batchSize) {
    const chunk = entries.slice(offset, offset + batchSize)
    await Promise.all(
      chunk.map((entry) =>
        preloadEntryPronunciation(entry, {
          rate: options?.rate,
          ttsEngine: options?.ttsEngine,
        }),
      ),
    )
  }
}
