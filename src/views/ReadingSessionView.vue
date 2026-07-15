<script setup lang="ts">
import dayjs from 'dayjs'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { ReadingSession, ReadingTarget } from '../types/models'
import {
  buildReadingTargetBatches,
  completeReadingSession,
  generateReadingSession,
  loadContextAttempts,
  parseReadingSession,
  recordContextAttempt,
  resetReadingSessionAttempts,
  saveReadingProgress,
} from '../modules/reading/readingService'
import { completeDailySession, setArticleStatus } from '../modules/review/dailyQueueService'
import { loadSettings } from '../modules/settings/settingsService'
import { lookupWord } from '../modules/dictionary/dictionaryService'
import { addEntryToStudyList, listStudyLists, LOOKUP_LIST_ID } from '../modules/wordbook/studyListService'
import type { DictionaryEntry, StudyList } from '../types/models'
import { parseJsonArray } from '../utils/json'
import { db } from '../db/database'

const route = useRoute()
const router = useRouter()
const dailySessionId = computed(() => typeof route.query.session === 'string' ? route.query.session : `daily:${dayjs().format('YYYY-MM-DD')}`)
const dayKey = dayjs().format('YYYY-MM-DD')
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
const readingCopy = ref<HTMLElement | null>(null)
const selectedWord = ref('')
const selectedEntry = ref<DictionaryEntry | null>(null)
const selectionLoading = ref(false)
const selectionMessage = ref('')
const studyLists = ref<StudyList[]>([])
const selectedListId = ref('')
const choosingList = ref(false)
let controller: AbortController | null = null
let selectionToken = 0

const parsed = computed(() => session.value ? parseReadingSession(session.value) : { segments: [], targets: [] })
const currentTarget = computed(() => parsed.value.targets[quizCursor.value])
const currentResultTarget = computed(() => parsed.value.targets[resultCursor.value])
const currentTargetResult = computed(() => currentTarget.value ? results.value[currentTarget.value.wordId] : undefined)

function carryOmittedToNextBatch() {
  const omitted = session.value?.omittedTargetWordIds ?? []
  if (!omitted.length || batchIndex.value + 1 >= batches.value.length) return
  const nextIndex = batchIndex.value + 1
  const combined = [...new Set([...omitted, ...(batches.value[nextIndex] ?? [])])]
  const chunks: string[][] = []
  for (let index = 0; index < combined.length; index += 12) chunks.push(combined.slice(index, index + 12))
  batches.value.splice(nextIndex, 1, ...chunks)
}

function restoreCursors() {
  if (!session.value) return
  const firstUnanswered = parsed.value.targets.findIndex((target) => !(target.wordId in results.value))
  quizCursor.value = firstUnanswered >= 0
    ? firstUnanswered
    : Math.min(session.value.quizCursor ?? Math.max(0, parsed.value.targets.length - 1), Math.max(0, parsed.value.targets.length - 1))
  resultCursor.value = Math.min(session.value.resultCursor ?? 0, Math.max(0, parsed.value.targets.length - 1))
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
  loading.value = true
  error.value = ''
  paragraphs.value = []
  generatedTargets.value = 0
  generationPhase.value = 'article'
  stage.value = 0
  results.value = {}
  showTranslation.value = false
  controller = new AbortController()
  await setArticleStatus(dailySessionId.value, 'generating')
  try {
    session.value = await generateReadingSession({
      dayKey, batchIndex: batchIndex.value, seed: 0, wordIds, level: level.value, topic: topic.value, force,
      signal: controller.signal,
      onProgress(progress) {
        generationPhase.value = progress.phase
        paragraphs.value = progress.paragraphs
        generatedTargets.value = progress.targetCount
      },
    })
    if (session.value.status === 'failed') throw new Error(session.value.error || '文章生成失败')
    await setArticleStatus(dailySessionId.value, 'ready')
    const attempts = await loadContextAttempts(session.value.sessionId)
    results.value = Object.fromEntries(attempts.map((attempt) => [attempt.wordId, attempt.result]))
    hadRetry.value = attempts.some((attempt) => attempt.result !== 'correct')
    stage.value = session.value.readerStage ?? (attempts.length ? 1 : 0)
    showTranslation.value = session.value.showTranslation ?? false
    restoreCursors()
    carryOmittedToNextBatch()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
    await setArticleStatus(dailySessionId.value, 'failed')
  } finally {
    loading.value = false
    controller = null
  }
}

async function initialize() {
  const settings = await loadSettings()
  level.value = settings.articleLevel
  noKey.value = !settings.deepseekApiKey.trim()
  batches.value = await buildReadingTargetBatches(dayKey)
  if (!batches.value.length) {
    await completeDailySession(dailySessionId.value, 'skipped')
    await router.replace('/review')
    return
  }
  const requestedBatch = Number(route.query.batch)
  if (Number.isInteger(requestedBatch) && requestedBatch >= 0 && requestedBatch < batches.value.length) {
    batchIndex.value = requestedBatch
  }
  const dailySession = await db.dailyLearningSessions.get(dailySessionId.value)
  if (dailySession?.articleStatus === 'stale') {
    staleArticle.value = true
    return
  }
  if (!noKey.value) await loadBatch()
}

async function continuePreviousArticle() {
  const cached = await db.readingSessions.get(`reading:${dayKey}:0:${batchIndex.value}`)
  if (!cached) {
    staleArticle.value = false
    await loadBatch(true)
    return
  }
  session.value = cached
  const attempts = await loadContextAttempts(cached.sessionId)
  results.value = Object.fromEntries(attempts.map((attempt) => [attempt.wordId, attempt.result]))
  hadRetry.value = attempts.some((attempt) => attempt.result !== 'correct')
  stage.value = cached.readerStage ?? (attempts.length ? 1 : 0)
  showTranslation.value = cached.showTranslation ?? false
  restoreCursors()
  staleArticle.value = false
  usingPreviousArticle.value = true
}

async function answer(target: ReadingTarget, choice?: string) {
  const attempt = await recordContextAttempt(session.value!.sessionId, target, choice, dailySessionId.value)
  results.value[target.wordId] = attempt.result
  if (attempt.result !== 'correct') hadRetry.value = true
  await persistProgress()
}

async function revealTargets() {
  stage.value = 1
  quizCursor.value = parsed.value.targets.findIndex((target) => !(target.wordId in results.value))
  if (quizCursor.value < 0) quizCursor.value = 0
  await persistProgress()
}

async function nextQuestion() {
  if (!currentTargetResult.value) return
  if (quizCursor.value + 1 < parsed.value.targets.length) {
    quizCursor.value += 1
    await persistProgress()
    return
  }
  await finishBatch()
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
  if (batchIndex.value + 1 < batches.value.length) {
    batchIndex.value += 1
    await loadBatch()
    return
  }
  if (hadRetry.value) {
    await setArticleStatus(dailySessionId.value, 'completed')
    await router.replace('/review/session')
  } else {
    await completeDailySession(dailySessionId.value, 'completed')
    await router.replace('/review')
  }
}

async function skip() {
  controller?.abort()
  await completeDailySession(dailySessionId.value, 'skipped')
  await router.replace('/review')
}

function cancel() { controller?.abort() }

function clearWordSelection() {
  selectedWord.value = ''
  selectedEntry.value = null
  selectionMessage.value = ''
  choosingList.value = false
}

async function updateSelectedWord() {
  const selection = window.getSelection()
  const text = selection?.toString().trim() ?? ''
  if (!selection || selection.rangeCount !== 1 || !/^[A-Za-z][A-Za-z'-]{0,79}$/.test(text)) {
    return
  }
  const range = selection.getRangeAt(0)
  const node = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer as Element
    : range.commonAncestorContainer.parentElement
  if (!node || !readingCopy.value?.contains(node)) return
  const token = ++selectionToken
  selectedWord.value = text
  selectedEntry.value = null
  selectionMessage.value = ''
  selectionLoading.value = true
  try {
    const result = await lookupWord(text)
    if (token !== selectionToken) return
    selectedEntry.value = result.exactMatches[0] ?? result.lemmaMatches[0] ?? null
  } finally {
    if (token === selectionToken) selectionLoading.value = false
  }
}

async function openSelectedLookup() {
  if (!selectedWord.value) return
  await persistProgress()
  await router.push({ path: '/lookup', query: { q: selectedWord.value, from: 'reading', returnTo: route.fullPath } })
}

async function addSelectedWord(listId = selectedListId.value) {
  if (!selectedEntry.value) {
    selectionMessage.value = '本地词典暂未找到，打开完整查词后可补全并加入。'
    return
  }
  if (!listId) {
    choosingList.value = true
    return
  }
  await addEntryToStudyList(listId, selectedEntry.value, 'article')
  window.localStorage.setItem('wordsbook:last-study-list', listId)
  const listName = studyLists.value.find((list) => list.listId === listId)?.name ?? '词表'
  selectionMessage.value = `已加入「${listName}」`
}

async function saveSelectedWord() {
  if (!selectedEntry.value) return openSelectedLookup()
  await addEntryToStudyList(LOOKUP_LIST_ID, selectedEntry.value, 'article')
  selectionMessage.value = '已仅保存，不进入每日学习'
}

onMounted(() => {
  void initialize()
  void listStudyLists().then((lists) => {
    studyLists.value = lists.filter((list) => list.systemType !== 'lookup')
    const last = window.localStorage.getItem('wordsbook:last-study-list')
    selectedListId.value = studyLists.value.find((list) => list.listId === last)?.listId
      ?? studyLists.value.find((list) => list.studyEnabled)?.listId
      ?? studyLists.value[0]?.listId
      ?? ''
  })
  document.addEventListener('selectionchange', updateSelectedWord)
})
onBeforeUnmount(() => {
  controller?.abort()
  document.removeEventListener('selectionchange', updateSelectedWord)
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
      <div class="action-row"><button class="btn btn-primary" :disabled="noKey" type="button" @click="regenerateStaleArticle">重新生成</button><button class="btn" type="button" @click="continuePreviousArticle">继续原文</button><button v-if="noKey" class="btn" type="button" @click="router.push('/settings')">配置 DeepSeek Key</button></div>
    </div>

    <div v-else-if="noKey" class="immersive-empty">
      <h1>需要配置 DeepSeek Key</h1>
      <p>文章是今日学习的可选步骤；不配置也可以完成卡片学习。</p>
      <div class="action-row"><button class="btn btn-primary" type="button" @click="router.push('/settings')">配置 DeepSeek Key</button><button class="btn" type="button" @click="skip">跳过文章并完成今日学习</button></div>
    </div>

    <div v-else-if="loading" class="reading-stream-state" aria-live="polite">
      <p class="eyebrow">{{ generationPhase === 'article' ? '正文流式生成中' : '正文已完成' }} · {{ level }}</p><h1>今日语境文章</h1>
      <p v-if="generationPhase === 'article'">目标词 {{ batches[batchIndex]?.length ?? 0 }} 个 · 正文会边生成边显示</p>
      <p v-else>正在准备测义题与翻译 · 已生成 {{ generatedTargets }} 题</p>
      <div v-if="paragraphs.length" class="reading-copy streaming-article"><p v-for="(paragraph, index) in paragraphs" :key="index">{{ paragraph }}</p></div>
      <div v-else class="skeleton-lines" aria-hidden="true"><span/><span/><span/></div>
      <button class="btn" type="button" @click="cancel">取消生成</button>
    </div>

    <div v-else-if="error" class="immersive-empty">
      <h1>文章暂时没有生成</h1><p class="error" role="alert">{{ error }}</p>
      <div v-if="paragraphs.length" class="reading-copy retained-article"><p v-for="(paragraph, index) in paragraphs" :key="index">{{ paragraph }}</p></div>
      <div class="action-row"><button class="btn btn-primary" type="button" @click="loadBatch(false)">{{ paragraphs.length ? '重试题目与翻译' : '重试' }}</button><button v-if="paragraphs.length" class="btn" type="button" @click="loadBatch(true)">重新生成正文</button><button class="btn" type="button" @click="skip">跳过并完成今日学习</button><button v-if="error.includes('Key')" class="btn" type="button" @click="router.push('/settings')">更新 Key</button></div>
    </div>

    <article v-else-if="session" class="reading-card">
      <p v-if="usingPreviousArticle" class="reading-coverage-note">原文章未包含后来加入的单词</p>
      <p v-else-if="session.omittedTargetWordIds?.length" class="reading-coverage-note">本篇已保留可用内容；{{ session.omittedTargetWordIds.length }} 个未自然覆盖的词将顺延到下一篇。</p>
      <div class="reading-title-row"><h1>{{ session.title }}</h1><button class="btn btn-quiet" type="button" @click="regenerate">重新生成</button></div>
      <div ref="readingCopy" class="reading-copy reading-copy-selectable"><template v-for="(segment, index) in parsed.segments" :key="index"><mark v-if="stage >= 1 && segment.wordId" :class="['target-word', { 'target-word-active': (stage === 1 && currentTarget?.wordId === segment.wordId) || (stage === 2 && currentResultTarget?.wordId === segment.wordId) }]">{{ segment.text }}</mark><span v-else>{{ segment.text }}</span></template></div>
      <button v-if="stage === 0" class="btn btn-primary" type="button" @click="revealTargets">我已读完，标出目标词</button>
      <section v-if="stage === 1 && currentTarget" class="quiz-list quiz-list-single" aria-live="polite">
        <div class="quiz-progress-row"><span>第 {{ quizCursor + 1 }} / {{ parsed.targets.length }} 题</span><progress :value="quizCursor + (currentTargetResult ? 1 : 0)" :max="parsed.targets.length" /></div>
        <article :key="currentTarget.wordId" class="entry-card context-question-card">
          <h2>{{ currentTarget.headword }}</h2>
          <div v-if="!currentTargetResult" class="context-choice-list">
            <button v-for="choice in currentTarget.choices" :key="choice" class="btn" type="button" @click="answer(currentTarget, choice)">{{ choice }}</button>
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
            <h2>{{ currentResultTarget.headword }}</h2>
            <div :class="['context-answer', results[currentResultTarget.wordId] === 'correct' ? 'correct' : 'incorrect']"><strong>{{ results[currentResultTarget.wordId] === 'correct' ? '回答正确' : results[currentResultTarget.wordId] === 'uncertain' ? '不确定' : '回答错误' }}</strong><p>答案：{{ currentResultTarget.contextualMeaning }}</p><p>{{ currentResultTarget.explanation }}</p></div>
          </article>
          <div class="quiz-result-nav"><button class="btn" type="button" :disabled="resultCursor === 0" @click="resultCursor -= 1; persistProgress()">上一题</button><button class="btn" type="button" :disabled="resultCursor + 1 >= parsed.targets.length" @click="resultCursor += 1; persistProgress()">下一题</button></div>
        </section>
        <button class="btn" type="button" @click="toggleTranslation">{{ showTranslation ? '隐藏全文翻译' : '显示全文翻译' }}</button>
        <p v-if="showTranslation" class="translation-panel">{{ session.translation }}</p>
        <button class="btn btn-primary" type="button" @click="nextBatch">{{ batchIndex + 1 < batches.length ? '下一篇' : '完成今日学习' }}</button>
      </template>
    </article>

    <aside v-if="selectedWord" class="reading-selection-bar" aria-live="polite">
      <div class="selection-word-summary">
        <strong>{{ selectedWord }}</strong>
        <span v-if="selectionLoading" class="muted">正在查词…</span>
        <span v-else class="muted">{{ selectedEntry ? (parseJsonArray(selectedEntry.sensesJson)[0] || '已有本地词条') : '本地暂无释义' }}</span>
        <button class="selection-close" type="button" aria-label="关闭选词操作" @click="clearWordSelection">×</button>
      </div>
      <div v-if="choosingList" class="selection-list-picker">
        <select v-model="selectedListId" aria-label="选择学习词表"><option v-for="list in studyLists" :key="list.listId" :value="list.listId">{{ list.name }}</option></select>
        <button class="btn btn-primary" type="button" @click="addSelectedWord()">确认加入</button>
      </div>
      <div class="selection-actions">
        <button class="btn" type="button" @click="openSelectedLookup">查词</button>
        <button class="btn btn-primary" type="button" @click="addSelectedWord()">加入学习</button>
        <button class="btn" type="button" @click="choosingList = !choosingList">选择词表</button>
        <button class="btn btn-quiet" type="button" @click="saveSelectedWord">仅保存</button>
      </div>
      <p v-if="selectionMessage" class="success selection-message">{{ selectionMessage }}</p>
    </aside>
  </section>
</template>
