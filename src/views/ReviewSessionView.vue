<script setup lang="ts">
import { liveQuery } from 'dexie'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { DailyQueueSnapshot } from '../modules/review/dailyQueueService'
import type { ReviewCard, ReviewRating } from '../types/models'
import {
  answerLearningActivity,
  extendDailyQueue,
  finishCardPhase,
  getOrCreateDailySession,
  loadDailyQueueSnapshot,
  setArticleStatus,
  skipWordInDailySession,
} from '../modules/review/dailyQueueService'
import { preGenerateDailyArticle, readingBatchRangeForRound } from '../modules/reading/readingService'
import { scheduleRoundPractice } from '../modules/reading/practiceService'
import { loadReviewCards, previewCardIntervals, setWordSuspended } from '../modules/review/reviewService'
import { enhanceOrCreateVocabularyEntry, fetchAiDictionaryDraft } from '../modules/dictionary/aiDefinitionService'
import { removeWordFromWordbook } from '../modules/wordbook/wordbookService'
import { playEntryPronunciation, stopActivePronunciation } from '../modules/dictionary/audioService'
import { loadSettings } from '../modules/settings/settingsService'
import { parseJsonArray } from '../utils/json'
import { definitionLines } from '../modules/dictionary/senseRecords'

const router = useRouter()
const route = useRoute()
const loading = ref(true)
const cardLoading = ref(false)
const grading = ref(false)
const revealMeaning = ref(false)
const snapshot = ref<DailyQueueSnapshot | null>(null)
const card = ref<ReviewCard | null>(null)
const coachingCard = ref<ReviewCard | null>(null)
const coachingVisible = ref(false)
const error = ref('')
const showWordMenu = ref(false)
const actionBusy = ref(false)
const showMoreSheet = ref(false)
const customCount = ref(15)
const noMoreWords = ref(false)
const autoPronunciation = ref(true)
const speechRate = ref(1)
const ttsEngine = ref<'auto' | 'browser' | 'youdao' | 'google' | 'dictionaryapi'>('auto')
const deepseekApiKey = ref('')
const deepseekBaseUrl = ref('')
const deepseekModel = ref('')
const articleEveryRounds = ref(2)
const articleLevel = ref<'A2' | 'B1' | 'B2' | 'C1'>('B2')
const definitionLanguage = ref<'adaptive' | 'english-first' | 'chinese-first'>('adaptive')
const aiDefinitionBusy = ref(false)
const aiDefinitionMessage = ref('')
const aiDefinitionMessageTone = ref<'success' | 'error'>('success')
const preloadingRound = ref<string | null>(null)
const intervals = ref<Record<ReviewRating, string>>({
  again: '明天',
  hard: '明天',
  good: '明天',
  easy: '明天',
})
let cardShownAt = Date.now()
let liveSubscription: { unsubscribe(): void } | undefined
let wakeupTimer: ReturnType<typeof setTimeout> | undefined
let cardLoadToken = 0

const selectedListIds = computed(() => typeof route.query.lists === 'string'
  ? route.query.lists.split(',').filter(Boolean)
  : undefined)
const currentItem = computed(() => snapshot.value?.current)
const atQueueCheckpoint = computed(() => Boolean(snapshot.value && !snapshot.value.current
  && !snapshot.value.items.some((item) => item.status === 'pending' || item.status === 'active')
  && (snapshot.value.session.phase === 'cards' || snapshot.value.session.phase === 'summary')))
const progress = computed(() => {
  if (!snapshot.value?.totalCards) return 0
  return Math.min(100, Math.round(snapshot.value.completedCards / snapshot.value.totalCards * 100))
})
const queueLabel = computed(() => `剩余 ${new Set(snapshot.value?.items
  .filter((item) => item.kind === 'card' && item.wordId && (item.status === 'pending' || item.status === 'active'))
  .map((item) => item.wordId)).size}`)
const roundLabel = computed(() => `第 ${snapshot.value?.session.activeRoundIndex ?? 1} 组`)
const tomorrowPriorityCount = computed(() => snapshot.value?.items.filter((item) => item.tomorrowPriority).length ?? 0)
const reasonLabel = computed(() => ({
  initial: '先回想释义，再查看答案',
  'new-repeat': '再次回忆',
  'again-repeat': '重新回忆',
  'hard-repeat': '再确认一次',
  'context-retry': '文章错词',
  reencounter: '重新学习 · 先理解，再主动回忆',
  'list-change': '今日新增',
  'extra-batch': '继续学习',
}[currentItem.value?.reason ?? 'initial']))
const memoryStateLabel = computed(() => currentItem.value?.stage === 'retry'
  ? '需稍后再测'
  : currentItem.value?.stage === 'learn' ? '待首次提取' : '到期提取')
const displayedDefinitions = computed(() => card.value
  ? definitionLines(card.value.entry, articleLevel.value, definitionLanguage.value)
  : [])
const coachingDefinitions = computed(() => coachingCard.value
  ? definitionLines(coachingCard.value.entry, articleLevel.value, definitionLanguage.value)
  : [])
const englishDefinitionFirst = computed(() => definitionLanguage.value === 'english-first'
  || (definitionLanguage.value === 'adaptive' && (articleLevel.value === 'B2' || articleLevel.value === 'C1')))
const deferredPending = computed(() => Boolean(snapshot.value
  && !snapshot.value.current
  && snapshot.value.session.phase === 'cards'
  && snapshot.value.items.some((item) => item.status === 'pending' || item.status === 'active')))
const waitMessage = computed(() => {
  if (snapshot.value?.nextAvailableAt) {
    const seconds = Math.max(1, Math.ceil((Date.parse(snapshot.value.nextAvailableAt) - Date.now()) / 1000))
    return `这个词需要留出间隔，约 ${seconds} 秒后可再测。`
  }
  if (snapshot.value?.waitingForActivities) return `还需间隔 ${snapshot.value.waitingForActivities} 个不同活动；系统会跨学习单元安排。`
  return '正在寻找下一项合适的学习活动。'
})

async function loadCurrentCard() {
  const item = snapshot.value?.current
  const token = ++cardLoadToken
  if (!item?.wordId) {
    card.value = null
    cardLoading.value = false
    return
  }
  if (card.value?.wordId !== item.wordId) card.value = null
  cardLoading.value = true
  try {
    const [cards, nextIntervals] = await Promise.all([
      loadReviewCards([item.wordId]),
      previewCardIntervals(item.wordId),
    ])
    // A newer load token or a different queue item always wins. Revision-only
    // changes do not invalidate the dictionary payload for the same card.
    if (token !== cardLoadToken || snapshot.value?.current?.itemId !== item.itemId) return
    card.value = cards[0] ?? null
    intervals.value = nextIntervals
    cardShownAt = Date.now()
    revealMeaning.value = false
    showWordMenu.value = false
    if (card.value && autoPronunciation.value) {
      void playEntryPronunciation(card.value.entry, {
        rate: speechRate.value,
        ttsEngine: ttsEngine.value,
      })
    }
  } finally {
    if (token === cardLoadToken) cardLoading.value = false
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
    deepseekApiKey.value = settings.deepseekApiKey
    deepseekBaseUrl.value = settings.deepseekBaseUrl
    deepseekModel.value = settings.deepseekModel
    articleEveryRounds.value = settings.articleEveryRounds
    articleLevel.value = settings.articleLevel
    definitionLanguage.value = settings.definitionLanguage
    snapshot.value = await getOrCreateDailySession(selectedListIds.value)
    subscribeToSession(snapshot.value.session.sessionId)
    if (snapshot.value.session.phase === 'practice') {
      await router.replace({ path: '/review/practice', query: { session: snapshot.value.session.sessionId } })
      return
    }
    void prewarmRoundContent()
    await loadCurrentCard()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    loading.value = false
  }
}

function scheduleQueueWakeup(nextAvailableAt?: string) {
  if (wakeupTimer) clearTimeout(wakeupTimer)
  if (!nextAvailableAt) return
  const delay = Math.max(50, Math.min(2_147_000_000, Date.parse(nextAvailableAt) - Date.now() + 50))
  wakeupTimer = setTimeout(async () => {
    try {
      if (!snapshot.value) return
      snapshot.value = await loadDailyQueueSnapshot(snapshot.value.session.sessionId)
      await loadCurrentCard()
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : String(reason)
    }
  }, delay)
}

function subscribeToSession(sessionId: string) {
  liveSubscription?.unsubscribe()
  liveSubscription = liveQuery(() => loadDailyQueueSnapshot(sessionId)).subscribe({
    next: (fresh) => {
      const currentRevision = snapshot.value?.session.sessionRevision ?? 0
      const incomingRevision = fresh.session.sessionRevision ?? 0
      if (incomingRevision < currentRevision) return
      const previousItemId = snapshot.value?.current?.itemId
      snapshot.value = fresh
      scheduleQueueWakeup(fresh.nextAvailableAt)
      if (
        !grading.value
        && (fresh.current?.itemId !== previousItemId || incomingRevision !== currentRevision)
      ) {
        void loadCurrentCard().catch((reason) => {
          error.value = reason instanceof Error ? reason.message : String(reason)
        })
      }
    },
    error: (reason) => {
      error.value = reason instanceof Error ? reason.message : String(reason)
    },
  })
}

watch(() => snapshot.value?.session.phase, async (phase) => {
  if (phase === 'practice') {
    await router.replace({ path: '/review/practice', query: { session: snapshot.value?.session.sessionId } })
    return
  }
  if (phase === 'article') {
    await router.replace({ path: '/review/reading', query: { session: snapshot.value?.session.sessionId } })
  }
})

async function maybeSchedulePractice(rating: ReviewRating, wordId: string) {
  if (!snapshot.value) return
  const roundIndex = snapshot.value.session.activeRoundIndex ?? 1
  let roundWordIds: string[] = []
  try {
    const rounds = JSON.parse(snapshot.value.session.roundsJson ?? '[]') as Array<{ index: number; wordIds: string[] }>
    roundWordIds = rounds.find((round) => round.index === roundIndex)?.wordIds ?? []
  } catch { roundWordIds = [] }
  if (!roundWordIds.length) return
  // A one-word unit cannot provide meaningful spacing after a successful card.
  // Leave its second retrieval for a later session instead of immediate overlearning.
  if (roundWordIds.length === 1 && (rating === 'good' || rating === 'easy')) return
  const attempted = new Set(snapshot.value.attempts
    .filter((attempt) => roundWordIds.includes(attempt.wordId))
    .map((attempt) => attempt.wordId))
  attempted.add(wordId)
  const reachedPreloadPoint = attempted.size >= Math.ceil(roundWordIds.length * 0.6)
  if (!reachedPreloadPoint && rating !== 'hard' && rating !== 'again') return
  await scheduleRoundPractice(snapshot.value.session.sessionId, roundIndex, { wordId, rating })
}

async function prewarmRoundContent() {
  const currentRound = snapshot.value?.session.activeRoundIndex ?? 1
  const range = snapshot.value?.session.engineVersion === 2
    ? {
        start: snapshot.value?.session.activeUnitIndex ?? 0,
        end: snapshot.value?.session.activeUnitIndex ?? 0,
      }
    : readingBatchRangeForRound(
        snapshot.value?.session.roundsJson,
        currentRound,
        Math.max(1, articleEveryRounds.value),
      )
  const preloadKey = `${range.start}-${range.end}`
  if (!deepseekApiKey.value.trim() || preloadingRound.value === preloadKey) return
  preloadingRound.value = preloadKey
  try {
    const articles = await Promise.all(Array.from(
      { length: range.end - range.start + 1 },
      (_, index) => preGenerateDailyArticle(snapshot.value!.session.dayKey, range.start + index),
    ))
    if (articles.every((article) => article?.status === 'ready' || article?.status === 'completed') && snapshot.value) {
      await setArticleStatus(snapshot.value.session.sessionId, 'ready')
      snapshot.value.session.articleStatus = 'ready'
    }
  } catch {
    // Preloading is intentionally best-effort; the learning flow has a local fallback.
  } finally {
    preloadingRound.value = null
  }
}

onMounted(() => void initialize())
onBeforeUnmount(() => {
  liveSubscription?.unsubscribe()
  if (wakeupTimer) clearTimeout(wakeupTimer)
})

async function onGrade(rating: ReviewRating) {
  const item = currentItem.value
  const answeredCard = card.value
  if (!item?.wordId || !snapshot.value || !answeredCard || answeredCard.wordId !== item.wordId || cardLoading.value) return
  grading.value = true
  error.value = ''
  stopActivePronunciation()
  try {
    await maybeSchedulePractice(rating, item.wordId)
    snapshot.value = await loadDailyQueueSnapshot(snapshot.value.session.sessionId)
    snapshot.value = await answerLearningActivity({
      sessionId: snapshot.value.session.sessionId,
      itemId: item.itemId,
      rating,
      expectedSessionRevision: snapshot.value.session.sessionRevision ?? 0,
      responseMs: Math.max(0, Date.now() - cardShownAt),
      evidenceKind: 'unprompted-card',
      skill: 'meaning-recall',
      hintLevel: revealMeaning.value ? 1 : 0,
    })
    const coachingItem = snapshot.value.items.find((row) =>
      row.wordId === item.wordId
      && row.coachingRequired
      && row.status === 'pending')
    if (coachingItem) {
      coachingCard.value = answeredCard
      coachingVisible.value = true
      void playEntryPronunciation(answeredCard.entry, {
        rate: speechRate.value,
        ttsEngine: ttsEngine.value,
      })
    }
    void prewarmRoundContent()
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

async function optimizeCurrentDefinition() {
  const current = card.value
  if (!current || aiDefinitionBusy.value) return
  if (!deepseekApiKey.value.trim()) {
    aiDefinitionMessageTone.value = 'error'
    aiDefinitionMessage.value = '请先到设置页填写 DeepSeek API Key'
    return
  }

  aiDefinitionBusy.value = true
  aiDefinitionMessage.value = ''
  try {
    const draft = await fetchAiDictionaryDraft({
      word: current.entry.headword,
      apiKey: deepseekApiKey.value,
      baseUrl: deepseekBaseUrl.value,
      model: deepseekModel.value,
      context: {
        originalHeadword: current.entry.headword,
        posList: current.entry.posList,
        senses: parseJsonArray(current.entry.sensesJson),
        note: current.note,
      },
    })
    const result = await enhanceOrCreateVocabularyEntry({
      wordId: current.wordId,
      entryId: current.entry.entryId,
      draft,
      model: deepseekModel.value,
    })
    card.value = (await loadReviewCards([current.wordId]))[0] ?? current
    aiDefinitionMessageTone.value = 'success'
    aiDefinitionMessage.value = result.created ? '已创建 AI 词条并更新释义' : '已更新，可在查词页回退'
  } catch (reason) {
    aiDefinitionMessageTone.value = 'error'
    aiDefinitionMessage.value = reason instanceof Error ? reason.message : 'AI 优化失败，请稍后重试'
  } finally {
    aiDefinitionBusy.value = false
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

async function addMore(count: number) {
  if (!snapshot.value || actionBusy.value) return
  actionBusy.value = true
  error.value = ''
  try {
    const previousTotal = snapshot.value.totalCards
    snapshot.value = await extendDailyQueue(snapshot.value.session.sessionId, count)
    noMoreWords.value = snapshot.value.totalCards === previousTotal
    showMoreSheet.value = false
    await loadCurrentCard()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally { actionBusy.value = false }
}

async function enterArticle() {
  if (!snapshot.value) return
  snapshot.value = await finishCardPhase(snapshot.value.session.sessionId)
  if (snapshot.value.session.phase === 'article') {
    await router.replace({ path: '/review/reading', query: { session: snapshot.value.session.sessionId } })
  } else {
    await router.replace('/review')
  }
}
</script>

<template>
  <section class="immersive-stage daily-queue-stage">
    <header class="immersive-header">
      <button class="btn" type="button" @click="router.push('/review')">退出</button>
      <div class="immersive-progress"><span>今日学习 · {{ roundLabel }}</span><strong>{{ queueLabel }}</strong></div>
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
          <span class="review-memory-confidence">{{ memoryStateLabel }}</span>
          <button class="review-delete-mini" :disabled="actionBusy" type="button" aria-haspopup="dialog" @click="showWordMenu = true">移除</button>
        </div>
        <div :class="['review-card-content', 'review-card-content-center', { 'review-card-content-revealed': revealMeaning }]">
          <div class="review-word-stack">
            <h1 class="review-word">{{ card.entry.headword }}</h1>
            <p class="review-phonetic muted">{{ card.entry.phonetic || '暂无音标' }}</p>
            <button class="btn review-play-inline" type="button" @click="play">播放发音</button>
          </div>
          <aside v-if="revealMeaning" class="review-answer-sheet review-answer-inline" aria-live="polite">
            <p class="muted">{{ card.entry.posList.join(' / ') || '释义' }}</p>
            <ul v-if="displayedDefinitions.length" class="review-definition-list">
              <li v-for="line in displayedDefinitions" :key="line.senseId">
                <div class="review-definition-primary">
                  <small v-if="line.pos" class="review-definition-pos">{{ line.pos }}</small>
                  <span>{{ line.primary }}</span>
                </div>
                <details v-if="line.secondary" class="review-secondary-definition">
                  <summary>{{ englishDefinitionFirst ? '查看中文核心义' : '查看英文解释' }}</summary>
                  <p>{{ line.secondary }}</p>
                </details>
              </li>
            </ul>
            <ul v-else><li v-for="sense in parseJsonArray(card.entry.sensesJson)" :key="sense">{{ sense }}</li></ul>
            <details v-if="parseJsonArray(card.entry.examplesJson).length" class="review-examples">
              <summary>例句</summary>
              <p v-for="example in parseJsonArray(card.entry.examplesJson)" :key="example" class="example">{{ example }}</p>
            </details>
            <p v-if="card.note" class="example">{{ card.note }}</p>
            <div class="review-ai-definition">
              <button
                class="btn btn-quiet review-ai-definition-btn"
                :disabled="aiDefinitionBusy || !deepseekApiKey.trim()"
                type="button"
                @click="optimizeCurrentDefinition"
              >
                {{ aiDefinitionBusy ? 'AI 处理中…' : 'AI 优化释义' }}
              </button>
              <p v-if="!deepseekApiKey.trim() && !aiDefinitionMessage" class="muted review-ai-definition-hint">配置 DeepSeek Key 后可用</p>
              <p v-if="aiDefinitionMessage" :class="aiDefinitionMessageTone === 'error' ? 'error' : 'success'" class="review-ai-definition-message" role="status">{{ aiDefinitionMessage }}</p>
            </div>
          </aside>
        </div>
      </section>
    </article>

    <section v-else-if="deferredPending" class="immersive-empty queue-checkpoint" aria-live="polite">
      <p class="eyebrow">间隔中</p>
      <h1>先换一种活动</h1>
      <p class="muted">{{ waitMessage }}</p>
      <p class="muted">无需反复点击；到达时间后队列会自动刷新。</p>
      <button class="btn btn-quiet" type="button" @click="router.push('/review')">暂时结束</button>
    </section>

    <section v-else-if="atQueueCheckpoint" class="immersive-empty queue-checkpoint" aria-live="polite">
      <p class="eyebrow">今日卡片</p>
      <h1>{{ snapshot?.session.status === 'completed' ? '今天还想再学一点？' : '今日卡片已完成' }}</h1>
      <p class="muted">可以继续进入文章，也可以再加一组到同一个队列。</p>
      <p v-if="tomorrowPriorityCount" class="review-tomorrow-priority" role="status">{{ tomorrowPriorityCount }} 个单词今日尚未掌握，已安排明日优先复习。</p>
      <p v-if="noMoreWords" class="muted">暂无更多可学单词。</p>
      <div class="actions">
        <button v-if="snapshot?.session.status !== 'completed'" class="btn btn-primary" type="button" @click="enterArticle">进入今日文章</button>
        <button class="btn" :disabled="actionBusy || noMoreWords" type="button" @click="showMoreSheet = true">再学一组</button>
        <button v-if="snapshot?.session.status === 'completed'" class="btn btn-quiet" type="button" @click="router.push('/review')">返回学习首页</button>
      </div>
    </section>
    <div v-else class="immersive-empty">{{ cardLoading ? '正在读取下一张卡片…' : '正在恢复今日进度…' }}</div>

    <footer v-if="card && currentItem && card.wordId === currentItem.wordId" :class="['review-grade-dock', revealMeaning ? 'review-grade-dock-four' : 'review-reveal-dock']">
      <button v-if="!revealMeaning" class="btn btn-primary review-reveal-action" :disabled="cardLoading || coachingVisible" type="button" @click="revealMeaning = true">显示释义</button>
      <template v-else>
        <button class="btn btn-danger review-action-btn" :disabled="grading || aiDefinitionBusy || cardLoading || coachingVisible" type="button" aria-label="不知道，按 Again 评分" @click="onGrade('again')">不知道 <small>{{ intervals.again }}</small><span class="review-grade-hint">至少 1 分钟后再测</span></button>
        <button class="btn review-action-btn review-hard" :disabled="grading || aiDefinitionBusy || cardLoading || coachingVisible" type="button" aria-label="模糊，按 Hard 评分" @click="onGrade('hard')">模糊 <small>{{ intervals.hard }}</small><span class="review-grade-hint">至少 3 分钟后再测</span></button>
        <button class="btn btn-primary review-action-btn" :disabled="grading || aiDefinitionBusy || cardLoading || coachingVisible" type="button" aria-label="记得，按 Good 评分" @click="onGrade('good')">记得 <small>{{ intervals.good }}</small><span class="review-grade-hint">本轮通过</span></button>
        <button class="btn review-action-btn review-easy" :disabled="grading || aiDefinitionBusy || cardLoading || coachingVisible" type="button" aria-label="秒懂，按 Easy 评分" @click="onGrade('easy')">秒懂 <small>{{ intervals.easy }}</small><span class="review-grade-hint">本轮通过</span></button>
      </template>
    </footer>

    <div v-if="coachingVisible && coachingCard" class="sheet-backdrop" role="presentation">
      <section class="bottom-action-sheet review-coaching-sheet" role="dialog" aria-modal="true" aria-label="单词讲解">
        <div>
          <p class="eyebrow">先讲解，再微复习</p>
          <h2>{{ coachingCard.entry.headword }}</h2>
          <p class="muted">{{ coachingCard.entry.phonetic || '暂无音标' }}</p>
        </div>
        <ul class="review-definition-list">
          <li v-for="line in coachingDefinitions" :key="line.senseId">
            <div class="review-definition-primary">
              <small v-if="line.pos" class="review-definition-pos">{{ line.pos }}</small>
              <span>{{ line.primary }}</span>
            </div>
            <p v-if="line.secondary" class="review-secondary-definition muted">{{ line.secondary }}</p>
          </li>
        </ul>
        <p v-for="example in parseJsonArray(coachingCard.entry.examplesJson).slice(0, 2)" :key="example" class="example">{{ example }}</p>
        <p class="muted">已经连续两次想不起来。本次不再立刻硬测，系统会在约 15 分钟后安排一次微复习。</p>
        <div class="actions">
          <button class="btn" type="button" @click="playEntryPronunciation(coachingCard.entry, { rate: speechRate, ttsEngine })">再听一次</button>
          <button class="btn btn-primary" type="button" @click="coachingVisible = false; coachingCard = null">我已看懂，继续</button>
        </div>
      </section>
    </div>

    <div v-if="showWordMenu" class="sheet-backdrop" role="presentation" @click.self="showWordMenu = false">
      <section class="bottom-action-sheet" role="dialog" aria-modal="true" aria-label="单词操作">
        <div><strong>{{ card?.entry.headword }}</strong><p class="muted">选择如何从今日学习中移除</p></div>
        <button class="btn" :disabled="actionBusy" type="button" @click="pauseCurrentWord">暂停学习</button>
        <button class="btn btn-danger" :disabled="actionBusy" type="button" @click="deleteCurrentWord">彻底删除</button>
        <button class="btn btn-quiet" :disabled="actionBusy" type="button" @click="showWordMenu = false">取消</button>
      </section>
    </div>

    <div v-if="showMoreSheet" class="sheet-backdrop" role="presentation" @click.self="showMoreSheet = false">
      <section class="bottom-action-sheet more-study-sheet" role="dialog" aria-modal="true" aria-label="继续学习">
        <div><strong>再学一组</strong><p class="muted">继续加入当前队列，不会改变已经完成的进度。</p></div>
        <div class="more-study-presets"><button class="btn btn-primary" :disabled="actionBusy" type="button" @click="addMore(5)">再学 5 个</button><button class="btn" :disabled="actionBusy" type="button" @click="addMore(10)">再学 10 个</button></div>
        <label class="more-study-custom"><span>自定义数量</span><input v-model.number="customCount" class="inline-input" type="number" min="1" max="100" inputmode="numeric" /></label>
        <button class="btn" :disabled="actionBusy || customCount < 1" type="button" @click="addMore(customCount)">加入队列</button>
        <button class="btn btn-quiet" :disabled="actionBusy" type="button" @click="showMoreSheet = false">取消</button>
      </section>
    </div>
  </section>
</template>
