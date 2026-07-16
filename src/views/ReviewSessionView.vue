<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { DailyQueueSnapshot } from '../modules/review/dailyQueueService'
import type { ReviewCard, ReviewRating } from '../types/models'
import {
  answerDailyCard,
  computeShortTermReview,
  extendDailyQueue,
  finishCardPhase,
  getOrCreateDailySession,
  setArticleStatus,
  skipWordInDailySession,
} from '../modules/review/dailyQueueService'
import { preGenerateDailyArticle } from '../modules/reading/readingService'
import { loadReviewCards, setWordSuspended } from '../modules/review/reviewService'
import { applyAiOverrideToEntry, fetchAiDictionaryDraft } from '../modules/dictionary/aiDefinitionService'
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
const showMoreSheet = ref(false)
const customCount = ref(15)
const noMoreWords = ref(false)
const autoPronunciation = ref(true)
const speechRate = ref(1)
const ttsEngine = ref<'auto' | 'browser' | 'youdao' | 'google' | 'dictionaryapi'>('auto')
const deepseekApiKey = ref('')
const deepseekBaseUrl = ref('')
const deepseekModel = ref('')
const aiDefinitionBusy = ref(false)
const aiDefinitionMessage = ref('')
const aiDefinitionMessageTone = ref<'success' | 'error'>('success')

const selectedListIds = computed(() => typeof route.query.lists === 'string'
  ? route.query.lists.split(',').filter(Boolean)
  : undefined)
const currentItem = computed(() => snapshot.value?.current)
const atQueueCheckpoint = computed(() => Boolean(snapshot.value && !snapshot.value.current
  && (snapshot.value.session.phase === 'cards' || snapshot.value.session.phase === 'summary')))
const progress = computed(() => {
  if (!snapshot.value?.totalCards) return 0
  return Math.min(100, Math.round(snapshot.value.completedCards / snapshot.value.totalCards * 100))
})
const queueLabel = computed(() => {
  const pending = snapshot.value?.items.filter((item) => item.kind === 'card' && item.status === 'pending').length ?? 0
  return `队列剩余 ${pending}`
})
const tomorrowPriorityCount = computed(() => snapshot.value?.items.filter((item) => item.tomorrowPriority).length ?? 0)
const reasonLabel = computed(() => ({
  initial: '先回想释义，再查看答案',
  'new-repeat': '再次回忆',
  'again-repeat': '重新回忆',
  'hard-repeat': '再确认一次',
  'context-retry': '文章错词',
  reencounter: '最近再次遇到，作为新词重学',
  'list-change': '今日新增',
  'extra-batch': '继续学习',
}[currentItem.value?.reason ?? 'initial']))
const todayMastery = computed(() => currentItem.value?.todayMastery ?? 0)
const previewRating = (rating: ReviewRating) => computeShortTermReview({
  mastery: todayMastery.value,
  recallStreak: currentItem.value?.recallStreak,
  weakSeen: currentItem.value?.weakSeen,
  wasNew: currentItem.value?.wasNew,
  startingLongTermRetrievability: currentItem.value?.startingLongTermRetrievability,
}, rating)
const masteryPreview = computed(() => ({
  good: previewRating('good'),
  hard: previewRating('hard'),
  again: previewRating('again'),
}))
const recallHint = computed(() => {
  const preview = masteryPreview.value.good
  if (preview.passed) return '这次记得即可通过'
  return `还需连续记得 ${Math.max(1, preview.requiredRecallStreak - preview.recallStreak)} 次`
})

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
    deepseekApiKey.value = settings.deepseekApiKey
    deepseekBaseUrl.value = settings.deepseekBaseUrl
    deepseekModel.value = settings.deepseekModel
    snapshot.value = await getOrCreateDailySession(selectedListIds.value)
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
    })
    await applyAiOverrideToEntry({
      entryId: current.entry.entryId,
      mode: 'replace',
      draft,
      model: deepseekModel.value,
    })
    card.value = (await loadReviewCards([current.wordId]))[0] ?? current
    aiDefinitionMessageTone.value = 'success'
    aiDefinitionMessage.value = '已更新，可在查词页回退'
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
          <span class="review-memory-confidence">短期记忆 {{ todayMastery }}%</span>
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

    <section v-else-if="atQueueCheckpoint" class="immersive-empty queue-checkpoint" aria-live="polite">
      <p class="eyebrow">本组完成</p>
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
    <div v-else class="immersive-empty">正在恢复今日进度…</div>

    <footer v-if="card" :class="['review-grade-dock', revealMeaning ? 'review-grade-dock-three' : 'review-reveal-dock']">
      <button v-if="!revealMeaning" class="btn btn-primary review-reveal-action" type="button" @click="revealMeaning = true">显示释义</button>
      <template v-else>
        <button class="btn btn-primary review-action-btn" :disabled="grading || aiDefinitionBusy" type="button" @click="onGrade('good')">记得 <small>{{ masteryPreview.good.mastery }}%</small><span class="review-grade-hint">{{ recallHint }}</span></button>
        <button class="btn review-action-btn review-hard" :disabled="grading || aiDefinitionBusy" type="button" @click="onGrade('hard')">模糊 <small>{{ masteryPreview.hard.mastery }}%</small><span class="review-grade-hint">稍后再出现</span></button>
        <button class="btn btn-danger review-action-btn" :disabled="grading || aiDefinitionBusy" type="button" @click="onGrade('again')">不知道 <small>{{ masteryPreview.again.mastery }}%</small><span class="review-grade-hint">很快再出现</span></button>
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
