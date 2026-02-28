import type { DictionaryEntry } from '../../types/models'

function getAudioUrl(audioKey: string): string {
  if (/^https?:\/\//.test(audioKey)) {
    return audioKey
  }

  return `/dictionaries/default/audio/${audioKey}`
}

function speakFallback(text: string, rate = 1): void {
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    return
  }

  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = 'en-US'
  utterance.rate = rate
  window.speechSynthesis.cancel()
  window.speechSynthesis.speak(utterance)
}

export async function playEntryPronunciation(entry: DictionaryEntry, rate = 1): Promise<void> {
  if (typeof window === 'undefined') {
    return
  }

  if (entry.audioKey) {
    try {
      const audio = new Audio(getAudioUrl(entry.audioKey))
      await audio.play()
      return
    } catch {
      // Continue to TTS fallback.
    }
  }

  speakFallback(entry.headword, rate)
}
