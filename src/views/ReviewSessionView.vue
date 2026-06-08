<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'
import type { ReviewCard, StudyPlan } from '../types/models'
import {
  playEntryPronunciation,
  preloadPronunciationQueue,
  stopActivePronunciation,
} from '../modules/dictionary/audioService'
import { buildTodayPlanCached, gradeCard, loadReviewCards } from '../modules/review/reviewService'
import { useSettingsStore } from '../modules/settings/settingsStore'
import { removeWordFromWordbook } from '../modules/wordbook/wordbookService'
import { parseJsonArray } from '../utils/json'

const router = useRouter()
const settingsStore = useSettingsStore()
const { settings } = storeToRefs(settingsStore)

const loading = ref(false)
const loadingText = ref('正在准备背词队列...')
const plan = ref<StudyPlan | null>(null)
const cards = ref<ReviewCard[]>([])
const currentIndex = ref(0)
const revealMeaning = ref(false)
const finished = ref(false)
const playMessage = ref('')
const audioPreparing = ref(false)
const preloadMessage = ref('')
const showSessionSettings = ref(false)
const deletingCurrent = ref(false)

let playbackToken = 0
let preloadToken = 0
let preloadStartTimer: number | null = null
const parsedLinesCache = new Map<string, string[]>()
const parseCacheLimit = 90

function getAudioProfile(): { lookahead: number; batchSize: number } {
  if (typeof window === 'undefined') {
    return { lookahead: 8, batchSize: 3 }
  }

  const nav = navigator as Navigator & { deviceMemory?: number }
  const isCoarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false
  const isLowMemoryDevice = typeof nav.deviceMemory === 'number' && nav.deviceMemory <= 4
  if (isCoarsePointer || isLowMemoryDevice) {
    return { lookahead: 5, batchSize: 2 }
  }

  return { lookahead: 8, batchSize: 3 }
}

const currentCard = computed(() => cards.value[currentIndex.value] ?? null)
const progressPercent = computed(() => {
  if (cards.value.length === 0) {
    return 0
  }

  return Math.round(((currentIndex.value + 1) / cards.value.length) * 100)
})

const queueSummary = computed(() => {
  if (cards.value.length === 0) {
    return '0 / 0'
  }

  return `${currentIndex.value + 1} / ${cards.value.length}`
})

watch(
  currentCard,
  async (card) => {
    if (!card) {
      return
    }

    playMessage.value = ''
    schedulePreloadUpcomingAudio()

    if (settings.value.autoPronunciation) {
      void playCurrentCardAudio(true)
    }
  },
  { immediate: false },
)

watch(
  () => settings.value.ttsEngine,
  () => {
    schedulePreloadUpcomingAudio(0)
  },
)

async function initialize() {
  loading.value = true
  finished.value = false
  revealMeaning.value = false
  currentIndex.value = 0

  try {
    await settingsStore.initialize()
    plan.value = await buildTodayPlanCached()
    cards.value = await loadReviewCards(plan.value.queueWordIds)
    finished.value = cards.value.length === 0
    schedulePreloadUpcomingAudio(220)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void initialize()
})

onUnmounted(() => {
  playbackToken += 1
  preloadToken += 1
  clearPreloadStartTimer()
  stopActivePronunciation()
  cards.value = []
  parsedLinesCache.clear()
})

function clearPreloadStartTimer() {
  if (preloadStartTimer !== null) {
    window.clearTimeout(preloadStartTimer)
    preloadStartTimer = null
  }
}

function schedulePreloadUpcomingAudio(delayMs = 180) {
  clearPreloadStartTimer()
  preloadStartTimer = window.setTimeout(() => {
    preloadStartTimer = null
    void preloadUpcomingAudio()
  }, delayMs)
}

async function playCurrentCardAudio(isAuto = false) {
  if (!currentCard.value) {
    return
  }

  const token = ++playbackToken
  audioPreparing.value = true

  try {
    const result = await playEntryPronunciation(currentCard.value.entry, {
      rate: settings.value.speechRate,
      ttsEngine: settings.value.ttsEngine,
    })

    if (token !== playbackToken) {
      return
    }

    if (!result.success) {
      playMessage.value = '发音失败：当前设备语音服务不可用'
    } else if (!isAuto) {
      playMessage.value = ''
    }
  } finally {
    if (token === playbackToken) {
      audioPreparing.value = false
    }
  }
}

async function preloadUpcomingAudio() {
  const token = ++preloadToken
  const audioProfile = getAudioProfile()
  const lookaheadEntries = cards.value
    .slice(currentIndex.value + 1, currentIndex.value + 1 + audioProfile.lookahead)
    .map((card) => card.entry)
  const preloadableEntries =
    settings.value.ttsEngine === 'browser' || settings.value.ttsEngine === 'auto'
      ? lookaheadEntries.filter((entry) => Boolean(entry.audioKey))
      : lookaheadEntries

  if (preloadableEntries.length === 0) {
    preloadMessage.value = ''
    return
  }

  preloadMessage.value = `语音预加载中（${preloadableEntries.length}）`
  await preloadPronunciationQueue(preloadableEntries, {
    ttsEngine: settings.value.ttsEngine,
    batchSize: audioProfile.batchSize,
  })

  if (token !== preloadToken) {
    return
  }

  preloadMessage.value = '语音缓存就绪'
  window.setTimeout(() => {
    if (preloadMessage.value === '语音缓存就绪') {
      preloadMessage.value = ''
    }
  }, 1200)
}

async function onPlayCurrent() {
  await playCurrentCardAudio(false)
}

function onReveal() {
  revealMeaning.value = true
}

async function onGrade(rating: 'remember' | 'forget') {
  if (!currentCard.value) {
    return
  }

  playbackToken += 1
  stopActivePronunciation()
  await gradeCard(currentCard.value.wordId, rating)

  if (currentIndex.value + 1 >= cards.value.length) {
    finished.value = true
    return
  }

  currentIndex.value += 1
  revealMeaning.value = false
  playMessage.value = ''
}

async function onDeleteCurrentCard() {
  const card = currentCard.value
  if (!card) {
    return
  }

  if (!window.confirm(`确认从单词本删除 ${card.entry.headword} 吗？`)) {
    return
  }

  deletingCurrent.value = true
  playbackToken += 1
  stopActivePronunciation()
  try {
    await removeWordFromWordbook(card.wordId)
    cards.value = cards.value.filter((item) => item.wordId !== card.wordId)
    if (currentIndex.value >= cards.value.length) {
      currentIndex.value = Math.max(0, cards.value.length - 1)
    }
    revealMeaning.value = false
    playMessage.value = '已从单词本删除'
    finished.value = cards.value.length === 0
  } finally {
    deletingCurrent.value = false
  }
}

async function onRestartQueue() {
  loadingText.value = '正在刷新复习计划...'
  await initialize()
}

async function onExit() {
  playbackToken += 1
  stopActivePronunciation()
  await router.push('/review')
}

async function onUpdateSessionBoolean(key: 'autoPronunciation', event: Event) {
  const target = event.target as HTMLInputElement
  await settingsStore.update({ [key]: target.checked })
}

async function onUpdateSessionNumber(key: 'speechRate', event: Event): Promise<void> {
  const target = event.target as HTMLInputElement
  const value = Number(target.value)
  if (!Number.isFinite(value)) {
    return
  }

  await settingsStore.update({ [key]: value })
}

async function onUpdateSessionEngine(event: Event): Promise<void> {
  const target = event.target as HTMLSelectElement
  await settingsStore.update({
    ttsEngine: target.value as 'auto' | 'browser' | 'youdao' | 'google' | 'dictionaryapi',
  })
}

function parseLines(raw: string): string[] {
  const cached = parsedLinesCache.get(raw)
  if (cached) {
    return cached
  }

  const parsed = parseJsonArray(raw)
  parsedLinesCache.set(raw, parsed)
  if (parsedLinesCache.size > parseCacheLimit) {
    parsedLinesCache.clear()
  }
  return parsed
}
</script>

<template>
  <section class="immersive-stage">
    <header class="immersive-header">
      <button type="button" class="btn" @click="onExit">退出</button>
      <div class="immersive-progress">
        <span>沉浸背词</span>
        <strong v-if="!loading && !finished">{{ queueSummary }}</strong>
      </div>
      <div class="immersive-header-actions">
        <button type="button" class="btn" @click="showSessionSettings = !showSessionSettings">
          {{ showSessionSettings ? '收起设置' : '设置' }}
        </button>
        <button v-if="finished" type="button" class="btn" @click="onRestartQueue">刷新</button>
        <span v-else class="progress-chip">{{ progressPercent }}%</span>
      </div>
    </header>

    <div class="immersive-progress-bar">
      <span :style="{ width: `${progressPercent}%` }" />
    </div>

    <Transition name="soft-fade-slide">
      <section v-if="showSessionSettings" class="session-settings-panel">
        <label class="setting-row">
          <span>自动播放发音</span>
          <input
            type="checkbox"
            :checked="settings.autoPronunciation"
            @change="onUpdateSessionBoolean('autoPronunciation', $event)"
          />
        </label>

        <label class="setting-row">
          <span>语速 {{ settings.speechRate.toFixed(1) }}</span>
          <input
            type="range"
            min="0.7"
            max="1.3"
            step="0.1"
            :value="settings.speechRate"
            @input="onUpdateSessionNumber('speechRate', $event)"
          />
        </label>

        <label class="setting-row">
          <span>TTS 引擎</span>
          <select class="inline-input" :value="settings.ttsEngine" @change="onUpdateSessionEngine">
            <option value="auto">自动（推荐）</option>
            <option value="browser">系统 TTS</option>
            <option value="youdao">Youdao 免费语音</option>
            <option value="google">Google 免费语音</option>
            <option value="dictionaryapi">DictionaryAPI 语音</option>
          </select>
        </label>
      </section>
    </Transition>

    <div v-if="loading" class="immersive-empty">
      <p>{{ loadingText }}</p>
    </div>

    <div v-else-if="finished" class="immersive-empty">
      <h2>本轮已完成</h2>
      <p v-if="plan">到期 {{ plan.dueCount }}，新词 {{ plan.newCount }}</p>
      <div class="actions">
        <button type="button" class="btn" @click="onRestartQueue">再来一轮</button>
        <button type="button" class="btn btn-primary" @click="onExit">返回</button>
      </div>
    </div>

    <article v-else-if="currentCard" class="review-card-stage">
      <div class="review-card-shadow review-card-shadow-back" aria-hidden="true" />
      <div class="review-card-shadow review-card-shadow-mid" aria-hidden="true" />

      <Transition name="review-card-swap" mode="out-in">
        <section :key="currentCard.wordId" class="immersive-card review-flashcard">
          <div class="review-card-content review-card-content-focus">
            <p class="immersive-caption">{{ currentCard.entry.dictionaryName || '本地词典' }}</p>

            <div class="review-word-stack">
              <h1 class="review-word">{{ currentCard.entry.headword }}</h1>
              <p class="muted review-phonetic">{{ currentCard.entry.phonetic || '无音标' }}</p>
              <button type="button" class="btn review-play-inline" @click="onPlayCurrent">发音</button>
            </div>

            <Transition name="review-reveal">
              <div v-if="revealMeaning" class="answer-panel review-answer-panel">
                <ul>
                  <li v-for="sense in parseLines(currentCard.entry.sensesJson)" :key="sense">{{ sense }}</li>
                </ul>

                <p v-for="example in parseLines(currentCard.entry.examplesJson)" :key="example" class="example">
                  {{ example }}
                </p>
              </div>
            </Transition>

            <p v-if="audioPreparing" class="muted">语音缓冲中...</p>
            <p v-else-if="preloadMessage" class="muted">{{ preloadMessage }}</p>
            <p v-if="playMessage" class="muted review-play-message">{{ playMessage }}</p>
          </div>

          <footer class="immersive-bottom-dock">
            <div class="review-action-row">
              <button
                v-if="!revealMeaning"
                type="button"
                class="btn btn-primary review-action-btn"
                :disabled="deletingCurrent"
                @click="onReveal"
              >
                显示释义
              </button>
              <template v-else>
                <button
                  type="button"
                  class="btn btn-danger review-action-btn"
                  :disabled="deletingCurrent"
                  @click="onGrade('forget')"
                >
                  忘记了
                </button>
                <button
                  type="button"
                  class="btn btn-primary review-action-btn"
                  :disabled="deletingCurrent"
                  @click="onGrade('remember')"
                >
                  记住了
                </button>
              </template>
              <button
                type="button"
                class="btn btn-danger review-action-btn review-delete-action"
                :disabled="deletingCurrent"
                @click="onDeleteCurrentCard"
              >
                {{ deletingCurrent ? '删除中...' : '删除此词' }}
              </button>
            </div>
          </footer>
        </section>
      </Transition>
    </article>
  </section>
</template>
