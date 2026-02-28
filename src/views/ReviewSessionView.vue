<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'
import type { ReviewCard, StudyPlan } from '../types/models'
import { playEntryPronunciation } from '../modules/dictionary/audioService'
import { buildTodayPlan, gradeCard, loadReviewCards } from '../modules/review/reviewService'
import { useSettingsStore } from '../modules/settings/settingsStore'
import { parseJsonArray } from '../utils/json'

const router = useRouter()
const settingsStore = useSettingsStore()
const { settings } = storeToRefs(settingsStore)

const loading = ref(false)
const loadingText = ref('正在生成沉浸式背诵队列...')
const plan = ref<StudyPlan | null>(null)
const cards = ref<ReviewCard[]>([])
const currentIndex = ref(0)
const revealMeaning = ref(false)
const finished = ref(false)

const currentCard = computed(() => cards.value[currentIndex.value] ?? null)
const progressPercent = computed(() => {
  if (cards.value.length === 0) {
    return 0
  }

  return Math.round(((currentIndex.value + 1) / cards.value.length) * 100)
})

const queueSummary = computed(() => `${currentIndex.value + 1} / ${cards.value.length}`)

watch(
  currentCard,
  async (card) => {
    if (card && settings.value.autoPronunciation) {
      await playEntryPronunciation(card.entry, settings.value.speechRate)
    }
  },
  { immediate: false },
)

async function initialize() {
  loading.value = true
  finished.value = false
  revealMeaning.value = false
  currentIndex.value = 0

  try {
    await settingsStore.initialize()
    plan.value = await buildTodayPlan()
    cards.value = await loadReviewCards(plan.value.queueWordIds)
    finished.value = cards.value.length === 0
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void initialize()
})

async function onPlayCurrent() {
  if (!currentCard.value) {
    return
  }

  await playEntryPronunciation(currentCard.value.entry, settings.value.speechRate)
}

function onReveal() {
  revealMeaning.value = true
}

async function onGrade(rating: 'remember' | 'forget') {
  if (!currentCard.value) {
    return
  }

  await gradeCard(currentCard.value.wordId, rating)

  if (currentIndex.value + 1 >= cards.value.length) {
    finished.value = true
    return
  }

  currentIndex.value += 1
  revealMeaning.value = false
}

async function onRestartQueue() {
  loadingText.value = '正在刷新复习计划...'
  await initialize()
}

async function onExit() {
  await router.push('/review')
}

function parseLines(raw: string): string[] {
  return parseJsonArray(raw)
}
</script>

<template>
  <section class="immersive-stage">
    <header class="immersive-header">
      <button class="btn" @click="onExit">退出</button>
      <div class="immersive-progress">
        <span>沉浸背诵</span>
        <strong v-if="!loading && !finished">{{ queueSummary }}</strong>
      </div>
      <button v-if="finished" class="btn" @click="onRestartQueue">刷新</button>
      <span v-else class="progress-chip">{{ progressPercent }}%</span>
    </header>

    <div class="immersive-progress-bar">
      <span :style="{ width: `${progressPercent}%` }" />
    </div>

    <div v-if="loading" class="immersive-empty">
      <p>{{ loadingText }}</p>
    </div>

    <div v-else-if="finished" class="immersive-empty">
      <h2>本轮背诵完成</h2>
      <p v-if="plan">到期 {{ plan.dueCount }}，新词 {{ plan.newCount }}</p>
      <div class="actions">
        <button class="btn" @click="onRestartQueue">再来一轮</button>
        <button class="btn btn-primary" @click="onExit">返回背词页</button>
      </div>
    </div>

    <article v-else-if="currentCard" class="immersive-card">
      <p class="immersive-caption">{{ currentCard.entry.dictionaryName || '词典' }}</p>
      <h1>{{ currentCard.entry.headword }}</h1>
      <p class="muted">{{ currentCard.entry.phonetic || '无音标' }}</p>

      <div class="actions">
        <button class="btn" @click="onPlayCurrent">播放发音</button>
        <button class="btn" :disabled="revealMeaning" @click="onReveal">查看释义</button>
      </div>

      <div v-if="revealMeaning" class="answer-panel">
        <ul>
          <li v-for="sense in parseLines(currentCard.entry.sensesJson)" :key="sense">{{ sense }}</li>
        </ul>

        <p v-for="example in parseLines(currentCard.entry.examplesJson)" :key="example" class="example">
          {{ example }}
        </p>

        <div class="actions">
          <button class="btn btn-danger" @click="onGrade('forget')">遗忘</button>
          <button class="btn btn-primary" @click="onGrade('remember')">记住</button>
        </div>
      </div>
    </article>
  </section>
</template>
