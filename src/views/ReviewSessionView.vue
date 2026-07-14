<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { DailyQueueSnapshot } from '../modules/review/dailyQueueService'
import type { ReviewCard, ReviewRating } from '../types/models'
import {
  answerDailyCard,
  getOrCreateDailySession,
  nextTodayMastery,
  setArticleStatus,
  skipWordInDailySession,
} from '../modules/review/dailyQueueService'
import { preGenerateDailyArticle } from '../modules/reading/readingService'
import { loadReviewCards, setWordSuspended } from '../modules/review/reviewService'
import { removeWordFromWordbook } from '../modules/wordbook/wordbookService'
import { playEntryPronunciation, stopActivePronunciation } from '../modules/dictionary/audioService'
import { loadSettings } from '../modules/settings/settingsService'
import { parseJsonArray } from '../utils/json'

const router = useRouter()
const route = useRoute()
const loading = ref(true)
const grading = ref(false)
const revealMeaning = ref(false)
const snapshot = ref<DailyQueueSnapshot | null>(null)
const card = ref<ReviewCard | null>(null)
const error = ref('')
const showWordMenu = ref(false)
const actionBusy = ref(false)
const autoPronunciation = ref(true)
const speechRate = ref(1)
const ttsEngine = ref<'auto' | 'browser' | 'youdao' | 'google' | 'dictionaryapi'>('auto')

const selectedListIds = computed(() => typeof route.query.lists === 'string'
  ? route.query.lists.split(',').filter(Boolean)
  : undefined)
const currentItem = computed(() => snapshot.value?.current)
const progress = computed(() => {
  if (!snapshot.value?.totalCards) return 0
  return Math.min(100, Math.round(snapshot.value.completedCards / snapshot.value.totalCards * 100))
})
const queueLabel = computed(() => {
  const pending = snapshot.value?.items.filter((item) => item.kind === 'card' && item.status === 'pending').length ?? 0
  return `队列剩余 ${pending}`
})
const reasonLabel = computed(() => ({
  initial: '先回想释义，再查看答案',
  'new-repeat': '再次回忆',
  'again-repeat': '重新回忆',
  'hard-repeat': '再确认一次',
  'context-retry': '文章错词',
}[currentItem.value?.reason ?? 'initial']))
const todayMastery = computed(() => currentItem.value?.todayMastery ?? 0)
const masteryPreview = computed(() => ({
  good: nextTodayMastery(todayMastery.value, 'good'),
  hard: nextTodayMastery(todayMastery.value, 'hard'),
  again: nextTodayMastery(todayMastery.value, 'again'),
}))

async function loadCurrentCard() {
  const item = snapshot.value?.current
  if (!item?.wordId) {
    card.value = null
    return
  }
  card.value = (await loadReviewCards([item.wordId]))[0] ?? null
  revealMeaning.value = false
  showWordMenu.value = false
  if (card.value && autoPronunciation.value) {
    void playEntryPronunciation(card.value.entry, {
      rate: speechRate.value,
      ttsEngine: ttsEngine.value,
    })
  }
}

async function initialize() {
  loading.value = true
  error.value = ''
  try {
    const settings = await loadSettings()
    autoPronunciation.value = settings.autoPronunciation
    speechRate.value = settings.speechRate
    ttsEngine.value = settings.ttsEngine
    snapshot.value = await getOrCreateDailySession(selectedListIds.value)
    if (snapshot.value.session.phase === 'summary') {
      await router.replace('/review')
      return
    }
    await loadCurrentCard()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    loading.value = false
  }
}

watch(() => snapshot.value?.session.phase, async (phase) => {
  if (phase === 'article') {
    await router.replace({ path: '/review/reading', query: { session: snapshot.value?.session.sessionId } })
  }
})

onMounted(() => void initialize())

async function onGrade(rating: ReviewRating) {
  const item = currentItem.value
  if (!item || !snapshot.value) return
  grading.value = true
  error.value = ''
  stopActivePronunciation()
  try {
    snapshot.value = await answerDailyCard(snapshot.value.session.sessionId, item.itemId, rating)
    const attemptedWords = new Set(snapshot.value.attempts.map((attempt) => attempt.wordId))
    if (snapshot.value.session.articleStatus === 'waiting' && snapshot.value.session.initialWordIds.every((wordId) => attemptedWords.has(wordId))) {
      await setArticleStatus(snapshot.value.session.sessionId, 'generating')
      snapshot.value.session.articleStatus = 'generating'
      void preGenerateDailyArticle(snapshot.value.session.dayKey).then(async (article) => {
        if (!snapshot.value) return
        await setArticleStatus(snapshot.value.session.sessionId, article?.status === 'ready' ? 'ready' : article ? 'failed' : 'waiting')
      })
    }
    if (snapshot.value.session.phase === 'summary') {
      await router.replace('/review')
      return
    }
    await loadCurrentCard()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    grading.value = false
  }
}

async function play() {
  if (card.value) await playEntryPronunciation(card.value.entry)
}

async function pauseCurrentWord() {
  if (!card.value || !snapshot.value) return
  actionBusy.value = true
  try {
    await setWordSuspended(card.value.wordId, true)
    await skipWordInDailySession(snapshot.value.session.sessionId, card.value.wordId)
    snapshot.value = await getOrCreateDailySession(selectedListIds.value)
    await loadCurrentCard()
  } finally {
    actionBusy.value = false
  }
}

async function deleteCurrentWord() {
  if (!card.value || !snapshot.value) return
  if (!window.confirm(`彻底删除「${card.value.entry.headword}」？词表归属、记忆状态和复习历史都会删除。`)) return
  actionBusy.value = true
  try {
    const wordId = card.value.wordId
    await skipWordInDailySession(snapshot.value.session.sessionId, wordId)
    await removeWordFromWordbook(wordId)
    snapshot.value = await getOrCreateDailySession(selectedListIds.value)
    await loadCurrentCard()
  } finally {
    actionBusy.value = false
  }
}
</script>

<template>
  <section class="immersive-stage daily-queue-stage">
    <header class="immersive-header">
      <button class="btn" type="button" @click="router.push('/review')">退出</button>
      <div class="immersive-progress"><span>今日学习</span><strong>{{ queueLabel }}</strong></div>
      <span class="progress-chip">{{ progress }}%</span>
    </header>
    <div class="immersive-progress-bar"><span :style="{ width: `${progress}%` }" /></div>

    <div v-if="loading" class="immersive-empty" aria-live="polite">正在恢复今日队列…</div>
    <div v-else-if="error" class="immersive-empty">
      <p class="error" role="alert">{{ error }}</p>
      <button class="btn btn-primary" type="button" @click="initialize">重试</button>
    </div>

    <article v-else-if="card && currentItem" class="review-card-stage">
      <div class="review-card-shadow review-card-shadow-back" />
      <div class="review-card-shadow review-card-shadow-mid" />
      <section class="immersive-card review-flashcard">
        <div class="review-card-topline">
          <span class="immersive-caption">{{ reasonLabel }}</span>
          <button class="review-delete-mini" :disabled="actionBusy" type="button" aria-haspopup="dialog" @click="showWordMenu = true">移除</button>
        </div>
        <div class="review-card-content review-card-content-center">
          <div class="review-word-stack">
            <h1 class="review-word">{{ card.entry.headword }}</h1>
            <p class="review-phonetic muted">{{ card.entry.phonetic || '暂无音标' }}</p>
            <button class="btn review-play-inline" type="button" @click="play">播放发音</button>
          </div>
          <aside v-if="revealMeaning" class="review-answer-sheet review-answer-inline" aria-live="polite">
            <p class="muted">{{ card.entry.posList.join(' / ') || '释义' }}</p>
            <ul><li v-for="sense in parseJsonArray(card.entry.sensesJson)" :key="sense">{{ sense }}</li></ul>
            <p v-if="card.note" class="example">{{ card.note }}</p>
          </aside>
        </div>
      </section>
    </article>

    <div v-else class="immersive-empty">正在进入今日文章…</div>

    <footer v-if="card" :class="['review-grade-dock', revealMeaning ? 'review-grade-dock-three' : 'review-reveal-dock']">
      <button v-if="!revealMeaning" class="btn btn-primary review-reveal-action" type="button" @click="revealMeaning = true">显示释义</button>
      <template v-else>
        <button class="btn btn-primary review-action-btn" :disabled="grading" type="button" @click="onGrade('good')">记得 <small>{{ masteryPreview.good }}%</small></button>
        <button class="btn review-action-btn review-hard" :disabled="grading" type="button" @click="onGrade('hard')">模糊 <small>{{ masteryPreview.hard }}%</small></button>
        <button class="btn btn-danger review-action-btn" :disabled="grading" type="button" @click="onGrade('again')">忘记 <small>{{ masteryPreview.again }}%</small></button>
      </template>
    </footer>

    <div v-if="showWordMenu" class="sheet-backdrop" role="presentation" @click.self="showWordMenu = false">
      <section class="bottom-action-sheet" role="dialog" aria-modal="true" aria-label="单词操作">
        <div><strong>{{ card?.entry.headword }}</strong><p class="muted">选择如何从今日学习中移除</p></div>
        <button class="btn" :disabled="actionBusy" type="button" @click="pauseCurrentWord">暂停学习</button>
        <button class="btn btn-danger" :disabled="actionBusy" type="button" @click="deleteCurrentWord">彻底删除</button>
        <button class="btn btn-quiet" :disabled="actionBusy" type="button" @click="showWordMenu = false">取消</button>
      </section>
    </div>
  </section>
</template>
