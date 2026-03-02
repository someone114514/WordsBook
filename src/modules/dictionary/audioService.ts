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
  const audio = new Audio(url)
  await audio.play()
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
    const response = await fetch(endpoint)
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

  if (ttsEngine === 'dictionaryapi' || ttsEngine === 'auto') {
    append(await resolveDictionaryApiAudioUrl(word))
  }

  if (ttsEngine === 'youdao' || ttsEngine === 'auto') {
    append(buildYoudaoTtsUrl(word))
  }

  if (ttsEngine === 'google' || ttsEngine === 'auto') {
    append(buildGoogleTtsUrl(word))
  }

  return urls
}

function speakFallback(text: string, rate = 1): boolean {
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    return false
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

  if (entry.audioKey) {
    try {
      await playAudioUrl(getAudioUrl(entry.audioKey))
      return { success: true, source: 'dictionary-audio' }
    } catch {
      // Continue to remote audio and TTS fallback.
    }
  }

  if (normalized.ttsEngine !== 'browser') {
    const remoteCandidates = await resolveRemoteAudioCandidates(entry.headword, normalized.ttsEngine)
    for (const url of remoteCandidates) {
      try {
        await playAudioUrl(url)
        return { success: true, source: 'remote-audio' }
      } catch {
        // try next source
      }
    }
  }

  if (speakFallback(entry.headword, normalized.rate)) {
    return { success: true, source: 'tts' }
  }

  return { success: false, source: 'none', error: 'no-audio-source' }
}
