<script setup lang="ts">
import dayjs from 'dayjs'
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { ReadingSession, ReadingTarget } from '../types/models'
import {
  appendOmittedReadingTargets,
  cancelReadingGeneration,
  completeReadingSession,
  getOrCreateReadingBatches,
  groupReadingSegmentsByParagraph,
  generateReadingSession,
  loadContextAttempts,
  parseReadingSession,
  readingBatchRangeForRound,
  readingSessionMatchesBatch,
  recordContextAttempt,
  resetReadingSessionAttempts,
  saveReadingProgress,
  setActiveReadingBatch,
  ReadingGenerationError,
} from '../modules/reading/readingService'
import { resumeDailyCardsAfterArticle, setArticleStatus } from '../modules/review/dailyQueueService'
import { loadSettings } from '../modules/settings/settingsService'
import { db } from '../db/database'

const route = useRoute()
const router = useRouter()
const dailySessionId = computed(() => typeof route.query.session === 'string' ? route.query.session : `daily:${dayjs().format('YYYY-MM-DD')}`)
const dayKey = computed(() => dailySessionId.value.startsWith('daily:')
  ? dailySessionId.value.slice('daily:'.length)
  : dayjs().format('YYYY-MM-DD'))
const isHistoryReview = computed(() => route.query.history === '1')
const batches = ref<string[][]>([])
const batchIndex = ref(0)
const session = ref<ReadingSession | null>(null)
const stage = ref<0 | 1 | 2>(0)
const results = ref<Record<string, 'correct' | 'wrong' | 'uncertain'>>({})
const loading = ref(false)
const error = ref('')
const noKey = ref(false)
const paragraphs = ref<string[]>([])
const generatedTargets = ref(0)
const generationPhase = ref<'article' | 'details'>('article')
const staleArticle = ref(false)
const usingPreviousArticle = ref(false)
const topic = ref('')
const level = ref<'A2' | 'B1' | 'B2' | 'C1'>('B2')
const showTranslation = ref(false)
const quizCursor = ref(0)
const resultCursor = ref(0)
const hadRetry = ref(false)
const generationErrorCode = ref<ReadingSession['errorCode']>()
let controller: AbortController | null = null
let questionShownAt = Date.now()

const parsed = computed(() => session.value ? parseReadingSession(session.value) : { segments: [], targets: [] })
const renderedParagraphs = computed(() => session.value ? groupReadingSegmentsByParagraph(parsed.value.segments) : [])
const currentTarget = computed(() => parsed.value.targets[quizCursor.value])
const currentResultTarget = computed(() => parsed.value.targets[resultCursor.value])
const currentTargetResult = computed(() => currentTarget.value ? results.value[currentTarget.value.wordId] : undefined)
const hasRetainedPassage = computed(() => paragraphs.value.length > 0 || Boolean(session.value && session.value.segmentsJson !== '[]'))
const isLocalFallback = computed(() => Boolean(session.value?.errorCode))
const errorTitle = computed(() => {
  if (generationErrorCode.value === 'missing-key' || error.value.includes('Key')) return '需要配置 DeepSeek Key'
  if (generationErrorCode.value === 'details-invalid') return '正文已生成，题目还没准备好'
  if (generationErrorCode.value === 'cancelled') return '文章生成已暂停'
  return '文章暂时没有生成'
})
const errorActionLabel = computed(() => generationErrorCode.value === 'details-invalid'
  ? '继续准备题目'
  : generationErrorCode.value === 'cancelled' ? '继续生成' : '重试')

function readingSessionId() {
  return `reading:${dayKey.value}:0:${batchIndex.value}`
}

async function restoreSavedArticle(cached: ReadingSession): Promise<void> {
  session.value = cached
  paragraphs.value = splitStoredPassage(cached)
  generationErrorCode.value = cached.errorCode
  const attempts = await loadContextAttempts(cached.sessionId)
  results.value = Object.fromEntries(attempts.map((attempt) => [attempt.wordId, attempt.result]))
  hadRetry.value = attempts.some((attempt) => attempt.result !== 'correct')
  stage.value = cached.readerStage ?? (attempts.length ? 1 : 0)
  showTranslation.value = cached.showTranslation ?? false
  restoreCursors()
}

function splitStoredPassage(row: ReadingSession | null): string[] {
  if (!row) return []
  try {
    const segments = JSON.parse(row.segmentsJson) as Array<{ text?: string }>
    const passage = segments.map((segment) => segment.text ?? '').join('').trim()
    return passage ? passage.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean) : []
  } catch { return [] }
}

async function carryOmittedToNextBatch() {
  const omitted = session.value?.omittedTargetWordIds ?? []
  if (!omitted.length) return
  batches.value = await appendOmittedReadingTargets(dailySessionId.value, batchIndex.value, omitted)
}

function restoreCursors() {
  if (!session.value) return
  const firstUnanswered = parsed.value.targets.findIndex((target) => !(target.wordId in results.value))
  quizCursor.value = firstUnanswered >= 0
    ? firstUnanswered
    : Math.min(session.value.quizCursor ?? Math.max(0, parsed.value.targets.length - 1), Math.max(0, parsed.value.targets.length - 1))
  resultCursor.value = Math.min(session.value.resultCursor ?? 0, Math.max(0, parsed.value.targets.length - 1))
}

async function setBatchIndex(nextIndex: number) {
  const bounded = Math.max(0, Math.min(nextIndex, Math.max(0, batches.value.length - 1)))
  batchIndex.value = bounded
  await setActiveReadingBatch(dailySessionId.value, bounded)
  await router.replace({ query: { ...route.query, batch: String(bounded) } })
}

async function persistProgress() {
  if (session.value) await saveReadingProgress(
    session.value.sessionId,
    stage.value,
    showTranslation.value,
    quizCursor.value,
    resultCursor.value,
  )
}

async function loadBatch(force = false) {
  const wordIds = batches.value[batchIndex.value]
  if (!wordIds) return
  if (force) await cancelReadingGeneration(readingSessionId())
  loading.value = true
  error.value = ''
  generationErrorCode.value = undefined
  paragraphs.value = []
  generatedTargets.value = 0
  generationPhase.value = 'article'
  stage.value = 0
  session.value = null
  results.value = {}
  showTranslation.value = false
  controller = new AbortController()
  await setArticleStatus(dailySessionId.value, 'generating')
  try {
    session.value = await generateReadingSession({
      dayKey: dayKey.value, batchIndex: batchIndex.value, seed: 0, wordIds, level: level.value, topic: topic.value, force,
      signal: controller.signal,
      onProgress(progress) {
        generationPhase.value = progress.phase
        paragraphs.value = progress.paragraphs
        generatedTargets.value = progress.targetCount
      },
    })
    paragraphs.value = splitStoredPassage(session.value)
    generationErrorCode.value = session.value.errorCode
    if (session.value.status === 'failed') {
      error.value = session.value.error || '文章生成失败，请重试'
      if (session.value.errorCode !== 'cancelled') await setArticleStatus(dailySessionId.value, 'failed')
      return
    }
    await setArticleStatus(dailySessionId.value, 'ready')
    await restoreSavedArticle(session.value)
    await carryOmittedToNextBatch()
    await setActiveReadingBatch(dailySessionId.value, batchIndex.value)
  } catch (reason) {
    generationErrorCode.value = reason instanceof ReadingGenerationError ? reason.code : undefined
    error.value = reason instanceof Error ? reason.message : String(reason)
    const cached = await db.readingSessions.get(readingSessionId())
    if (cached) await restoreSavedArticle(cached)
    if (generationErrorCode.value !== 'cancelled') await setArticleStatus(dailySessionId.value, 'failed')
  } finally {
    loading.value = false
    controller = null
  }
}

async function initialize() {
  const settings = await loadSettings()
  level.value = settings.articleLevel
  noKey.value = !settings.deepseekApiKey.trim()
  const requestedBatch = Number(route.query.batch)
  if (isHistoryReview.value && Number.isInteger(requestedBatch) && requestedBatch >= 0) {
    batchIndex.value = requestedBatch
    const historical = await db.readingSessions.get(readingSessionId())
    if (historical) {
      if (historical.status === 'ready' || historical.status === 'completed') {
        if (route.query.restart === '1') {
          await resetReadingSessionAttempts(historical.sessionId)
          await saveReadingProgress(historical.sessionId, 0, false, 0, 0)
          await restoreSavedArticle({ ...historical, readerStage: 0, showTranslation: false, quizCursor: 0, resultCursor: 0 })
        } else {
          await restoreSavedArticle(historical)
        }
        return
      }
      const sourceWords = historical.sourceWordIds?.length ? historical.sourceWordIds : historical.targetWordIds
      if (sourceWords.length) {
        batches.value = Array.from({ length: requestedBatch + 1 }, (_, index) => index === requestedBatch ? sourceWords : [])
        await loadBatch()
        return
      }
      if (route.query.restart === '1') {
        await resetReadingSessionAttempts(historical.sessionId)
        await saveReadingProgress(historical.sessionId, 0, false, 0, 0)
        await restoreSavedArticle({ ...historical, readerStage: 0, showTranslation: false, quizCursor: 0, resultCursor: 0 })
      } else {
        await restoreSavedArticle(historical)
      }
      return
    }
  }
  batches.value = await getOrCreateReadingBatches(dailySessionId.value, dayKey.value)
  if (!batches.value.length) {
    const resumed = await resumeDailyCardsAfterArticle(dailySessionId.value)
    await router.replace(resumed.session.status === 'completed' ? '/review' : '/review/session')
    return
  }
  const dailySession = await db.dailyLearningSessions.get(dailySessionId.value)
  const requestedOrStoredBatch = Number.isInteger(requestedBatch) && requestedBatch >= 0
    ? requestedBatch
    : (dailySession?.activeReadingBatchIndex ?? 0)
  if (requestedOrStoredBatch >= 0 && requestedOrStoredBatch < batches.value.length) {
    await setBatchIndex(requestedOrStoredBatch)
  }
  const cached = await db.readingSessions.get(readingSessionId())
  const expectedWordIds = batches.value[batchIndex.value]
  if (cached
    && (cached.status === 'ready' || cached.status === 'completed')
    && readingSessionMatchesBatch(cached, expectedWordIds)) {
    if (route.query.restart === '1') {
      await resetReadingSessionAttempts(cached.sessionId)
      await saveReadingProgress(cached.sessionId, 0, false, 0, 0)
      await restoreSavedArticle({ ...cached, readerStage: 0, showTranslation: false, quizCursor: 0, resultCursor: 0 })
    } else {
      await restoreSavedArticle(cached)
    }
    return
  }
  if (dailySession?.articleStatus === 'stale') {
    staleArticle.value = true
    return
  }
  await loadBatch()
}

async function continuePreviousArticle() {
  const cached = await db.readingSessions.get(readingSessionId())
  if (!cached) {
    staleArticle.value = false
    await loadBatch(true)
    return
  }
  if (cached.status !== 'ready' && cached.status !== 'completed') {
    staleArticle.value = false
    await loadBatch(false)
    return
  }
  await restoreSavedArticle(cached)
  await carryOmittedToNextBatch()
  await setActiveReadingBatch(dailySessionId.value, batchIndex.value)
  staleArticle.value = false
  usingPreviousArticle.value = true
}

async function answer(target: ReadingTarget, choice?: string) {
  const attempt = await recordContextAttempt(
    session.value!.sessionId,
    target,
    choice,
    dailySessionId.value,
    { responseMs: Math.max(0, Date.now() - questionShownAt), hintLevel: 0 },
  )
  results.value[target.wordId] = attempt.result
  if (attempt.result !== 'correct') hadRetry.value = true
  await persistProgress()
}

async function revealTargets() {
  if (!parsed.value.targets.length) {
    await finishBatch()
    return
  }
  stage.value = 1
  questionShownAt = Date.now()
  quizCursor.value = parsed.value.targets.findIndex((target) => !(target.wordId in results.value))
  if (quizCursor.value < 0) quizCursor.value = 0
  await persistProgress()
}

async function nextQuestion() {
  if (!currentTargetResult.value) return
  if (quizCursor.value + 1 < parsed.value.targets.length) {
    quizCursor.value += 1
    questionShownAt = Date.now()
    await persistProgress()
    return
  }
  await finishBatch()
}

async function moveResultCursor(delta: number) {
  const max = Math.max(0, parsed.value.targets.length - 1)
  const next = Math.max(0, Math.min(resultCursor.value + delta, max))
  if (next === resultCursor.value) return
  resultCursor.value = next
  await persistProgress()
}

async function finishBatch() {
  if (session.value) await completeReadingSession(session.value.sessionId)
  stage.value = 2
  resultCursor.value = 0
  await persistProgress()
}

async function toggleTranslation() {
  showTranslation.value = !showTranslation.value
  await persistProgress()
}

async function regenerate() {
  if (!session.value) return
  await saveReadingProgress(session.value.sessionId, 0, false, 0, 0)
  await resetReadingSessionAttempts(session.value.sessionId)
  results.value = {}
  stage.value = 0
  showTranslation.value = false
  hadRetry.value = false
  quizCursor.value = 0
  resultCursor.value = 0
  staleArticle.value = false
  usingPreviousArticle.value = false
  await loadBatch(true)
}

async function regenerateStaleArticle() {
  staleArticle.value = false
  usingPreviousArticle.value = false
  await loadBatch(true)
}

async function nextBatch() {
  if (isHistoryReview.value) {
    await router.replace('/review/reading/history')
    return
  }
  const daily = await db.dailyLearningSessions.get(dailySessionId.value)
  const range = daily?.engineVersion === 2
    ? { start: batchIndex.value, end: batchIndex.value }
    : readingBatchRangeForRound(
        daily?.roundsJson,
        daily?.lastArticleRoundIndex ?? daily?.activeRoundIndex ?? 1,
        daily?.readingBatchRounds ?? 2,
      )
  if (batchIndex.value < range.end && batchIndex.value + 1 < batches.value.length) {
    await setBatchIndex(batchIndex.value + 1)
    await loadBatch()
    return
  }
  await setArticleStatus(dailySessionId.value, 'completed')
  const resumed = await resumeDailyCardsAfterArticle(dailySessionId.value)
  await router.replace(resumed.session.status === 'completed' ? '/review' : '/review/session')
}

async function skip() {
  controller?.abort()
  await cancelReadingGeneration(readingSessionId())
  if (isHistoryReview.value) {
    await router.replace('/review/reading/history')
    return
  }
  await setArticleStatus(dailySessionId.value, 'skipped')
  const resumed = await resumeDailyCardsAfterArticle(dailySessionId.value)
  await router.replace(resumed.session.status === 'completed' ? '/review' : '/review/session')
}

async function cancel() {
  controller?.abort()
  await cancelReadingGeneration(readingSessionId())
  error.value = '正文已保存，生成已暂停；点击继续准备题目即可恢复。'
  generationErrorCode.value = 'cancelled'
  loading.value = false
}

onMounted(() => {
  void initialize()
})
</script>

<template>
  <section class="immersive-stage reading-stage">
    <header class="immersive-header">
      <button class="btn" type="button" @click="skip">跳过</button>
      <strong>今日文章 {{ batches.length ? `${batchIndex + 1}/${batches.length}` : '' }}</strong>
      <span class="progress-chip">{{ batches[batchIndex]?.length ?? 0 }} 词</span>
    </header>

    <div v-if="staleArticle" class="immersive-empty article-stale-state">
      <h1>文章需要更新</h1>
      <p>新增词尚未包含在原文章中，可以重新生成，也可以继续阅读原文。</p>
      <div class="action-row"><button class="btn btn-primary" type="button" @click="regenerateStaleArticle">重新准备</button><button class="btn" type="button" @click="continuePreviousArticle">继续原文</button><button v-if="noKey" class="btn" type="button" @click="router.push('/settings')">配置 DeepSeek Key</button></div>
    </div>

    <article v-else class="reading-card reading-card-stable" :aria-busy="loading">
      <p v-if="usingPreviousArticle" class="reading-coverage-note">原文章未包含后来加入的单词</p>
      <p v-else-if="session?.status === 'ready' && session?.errorCode" class="reading-coverage-note">AI 暂不可用；以下是离线词汇预习，不是生成文章。核心学习仍可继续。</p>
      <p v-if="session?.omittedTargetWordIds?.length" class="reading-coverage-note">本篇已保留可用内容；{{ session.omittedTargetWordIds.length }} 个未自然覆盖的词将顺延到下一篇。</p>
      <p v-if="session?.unquizzedTargetWordIds?.length" class="reading-coverage-note">另有 {{ session.unquizzedTargetWordIds.length }} 个词已在正文出现，但题目未通过校验；正文仍可正常阅读。</p>
      <div class="reading-title-row">
        <div>
          <p class="eyebrow">{{ isLocalFallback ? '离线词汇预习' : generationPhase === 'article' ? '语境阅读' : '题目准备' }} · {{ level }}</p>
          <h1>{{ isLocalFallback ? '离线词汇预习' : session?.title || '今日语境文章' }}</h1>
        </div>
        <button v-if="loading" class="btn btn-quiet" type="button" @click="cancel">取消生成</button>
        <button v-else-if="session" class="btn btn-quiet" type="button" @click="regenerate">重新准备</button>
      </div>
      <p class="reading-generation-status" aria-live="polite">
        <template v-if="loading">{{ generationPhase === 'article' ? '正文流式生成中，完成后会在下方准备题目' : `正在准备测义题与翻译${generatedTargets ? ` · 已完成 ${generatedTargets} 题` : ''}` }}</template>
        <template v-else-if="error">{{ errorTitle }}</template>
        <template v-else-if="session">{{ parsed.targets.length ? '读完正文后开始测义' : isLocalFallback ? '本地预习不生成未经验证的选择题' : '正文已保留；本批没有通过校验的题目' }}</template>
        <template v-else>正在恢复文章进度…</template>
      </p>

      <div class="reading-copy reading-copy-selectable reading-copy-stable">
        <template v-if="loading || error">
          <p v-for="(paragraph, index) in paragraphs" :key="index">{{ paragraph }}</p>
          <div v-if="!paragraphs.length" class="skeleton-lines" aria-hidden="true"><span/><span/><span/></div>
        </template>
        <template v-else-if="session">
          <p v-for="(paragraph, paragraphIndex) in renderedParagraphs" :key="paragraphIndex"><template v-for="(segment, index) in paragraph" :key="index"><mark v-if="stage >= 1 && segment.wordId" :class="['target-word', { 'target-word-active': (stage === 1 && currentTarget?.wordId === segment.wordId) || (stage === 2 && currentResultTarget?.wordId === segment.wordId) }]">{{ segment.text }}</mark><span v-else>{{ segment.text }}</span></template></p>
        </template>
        <div v-else class="skeleton-lines" aria-hidden="true"><span/><span/><span/></div>
      </div>

      <section v-if="loading" class="reading-question-placeholder" aria-live="polite">
        <strong>{{ generationPhase === 'article' ? '题目区域已准备好' : '题目正在加载' }}</strong>
        <span>正文位置保持不变，题目完成后会出现在这里</span>
        <div class="skeleton-lines" aria-hidden="true"><span/><span/><span/></div>
      </section>

      <section v-else-if="error" class="reading-generation-error" aria-live="polite">
        <h2>{{ errorTitle }}</h2>
        <p class="error" role="alert">{{ error }}</p>
        <p v-if="hasRetainedPassage" class="muted">已保存正文，不会丢失；可以继续准备题目或重新生成正文。</p>
        <div class="action-row">
          <button class="btn btn-primary" type="button" @click="loadBatch(false)">{{ errorActionLabel }}</button>
          <button v-if="hasRetainedPassage" class="btn" type="button" @click="loadBatch(true)">重新生成正文</button>
          <button class="btn" type="button" @click="skip">跳过并完成今日学习</button>
          <button v-if="generationErrorCode === 'missing-key' || error.includes('Key')" class="btn" type="button" @click="router.push('/settings')">去设置</button>
        </div>
      </section>

      <template v-else-if="session">
        <button v-if="stage === 0" class="btn btn-primary" type="button" @click="revealTargets">{{ parsed.targets.length ? '我已读完，开始测义' : '我已读完，继续学习' }}</button>
        <section v-if="stage === 1 && currentTarget" class="quiz-list quiz-list-single" aria-live="polite">
          <div class="quiz-progress-row"><span>第 {{ quizCursor + 1 }} / {{ parsed.targets.length }} 题</span><progress :value="quizCursor + (currentTargetResult ? 1 : 0)" :max="parsed.targets.length" /></div>
          <article :key="currentTarget.wordId" class="entry-card context-question-card">
            <h2>{{ currentTarget.headword }}<small v-if="currentTarget.surfaceForm">（文中：{{ currentTarget.surfaceForm }}）</small></h2>
            <div v-if="!currentTargetResult" class="context-choice-list">
              <button v-for="choice in currentTarget.choices" :key="choice" class="btn context-meaning-choice" type="button" @click="answer(currentTarget, choice)">{{ choice }}</button>
              <button class="btn btn-quiet" type="button" @click="answer(currentTarget)">不确定</button>
            </div>
            <template v-else>
              <div :class="['context-answer', currentTargetResult === 'correct' ? 'correct' : 'incorrect']"><strong>{{ currentTargetResult === 'correct' ? '回答正确' : currentTargetResult === 'uncertain' ? '不确定' : '回答错误' }}</strong><p>答案：{{ currentTarget.contextualMeaning }}</p><p>{{ currentTarget.explanation }}</p></div>
              <button class="btn btn-primary context-next-question" type="button" @click="nextQuestion">{{ quizCursor + 1 < parsed.targets.length ? '下一题' : '查看全部结果' }}</button>
            </template>
          </article>
        </section>
        <template v-if="stage === 2">
          <section v-if="currentResultTarget" class="quiz-result-carousel" aria-live="polite">
            <div class="quiz-progress-row"><strong>答题结果</strong><span>{{ resultCursor + 1 }} / {{ parsed.targets.length }}</span></div>
            <article class="entry-card context-result-card">
              <h2>{{ currentResultTarget.headword }}<small v-if="currentResultTarget.surfaceForm">（文中：{{ currentResultTarget.surfaceForm }}）</small></h2>
              <div :class="['context-answer', results[currentResultTarget.wordId] === 'correct' ? 'correct' : 'incorrect']"><strong>{{ results[currentResultTarget.wordId] === 'correct' ? '回答正确' : results[currentResultTarget.wordId] === 'uncertain' ? '不确定' : '回答错误' }}</strong><p>答案：{{ currentResultTarget.contextualMeaning }}</p><p>{{ currentResultTarget.explanation }}</p></div>
            </article>
            <div class="quiz-result-nav"><button class="btn" type="button" :disabled="resultCursor === 0" @click="moveResultCursor(-1)">上一题</button><button class="btn" type="button" :disabled="resultCursor + 1 >= parsed.targets.length" @click="moveResultCursor(1)">下一题</button></div>
          </section>
          <button class="btn" type="button" @click="toggleTranslation">{{ showTranslation ? '隐藏全文翻译' : '显示全文翻译' }}</button>
          <p v-if="showTranslation" class="translation-panel">{{ session.translation }}</p>
          <button class="btn btn-primary" type="button" @click="nextBatch">{{ isHistoryReview ? '返回文章记录' : '继续学习' }}</button>
        </template>
      </template>
    </article>

  </section>
</template>
