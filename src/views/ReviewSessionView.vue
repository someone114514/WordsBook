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
const loadingText = ref('Preparing immersive review queue...')
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
  loadingText.value = 'Refreshing review plan...'
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
      <button class="btn" @click="onExit">Exit</button>
      <div class="immersive-progress">
        <span>Immersive Session</span>
        <strong v-if="!loading && !finished">{{ queueSummary }}</strong>
      </div>
      <button v-if="finished" class="btn" @click="onRestartQueue">Refresh</button>
      <span v-else class="progress-chip">{{ progressPercent }}%</span>
    </header>

    <div class="immersive-progress-bar">
      <span :style="{ width: `${progressPercent}%` }" />
    </div>

    <div v-if="loading" class="immersive-empty">
      <p>{{ loadingText }}</p>
    </div>

    <div v-else-if="finished" class="immersive-empty">
      <h2>Queue Completed</h2>
      <p v-if="plan">Due {{ plan.dueCount }}, New {{ plan.newCount }}</p>
      <div class="actions">
        <button class="btn" @click="onRestartQueue">Start Again</button>
        <button class="btn btn-primary" @click="onExit">Back</button>
      </div>
    </div>

    <article v-else-if="currentCard" class="immersive-card">
      <p class="immersive-caption">{{ currentCard.entry.dictionaryName || 'Dictionary' }}</p>
      <h1>{{ currentCard.entry.headword }}</h1>
      <p class="muted">{{ currentCard.entry.phonetic || 'No phonetic' }}</p>

      <div class="actions">
        <button class="btn" @click="onPlayCurrent">Play</button>
        <button class="btn" :disabled="revealMeaning" @click="onReveal">Reveal Meaning</button>
      </div>

      <div v-if="revealMeaning" class="answer-panel">
        <ul>
          <li v-for="sense in parseLines(currentCard.entry.sensesJson)" :key="sense">{{ sense }}</li>
        </ul>

        <p v-for="example in parseLines(currentCard.entry.examplesJson)" :key="example" class="example">
          {{ example }}
        </p>

        <div class="actions">
          <button class="btn btn-danger" @click="onGrade('forget')">Forget</button>
          <button class="btn btn-primary" @click="onGrade('remember')">Remember</button>
        </div>
      </div>
    </article>
  </section>
</template>
