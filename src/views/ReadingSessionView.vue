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
const allAnswered = computed(() => parsed.value.targets.every((target) => target.wordId in results.value))

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
    stage.value = session.value.readerStage ?? (attempts.length ? 1 : 0)
    showTranslation.value = session.value.showTranslation ?? false
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
  stage.value = cached.readerStage ?? (attempts.length ? 1 : 0)
  showTranslation.value = cached.showTranslation ?? false
  staleArticle.value = false
  usingPreviousArticle.value = true
}

async function answer(target: ReadingTarget, choice?: string) {
  const attempt = await recordContextAttempt(session.value!.sessionId, target, choice, dailySessionId.value)
  results.value[target.wordId] = attempt.result
  if (attempt.result !== 'correct') hadRetry.value = true
}

async function revealTargets() {
  stage.value = 1
  if (session.value) await saveReadingProgress(session.value.sessionId, stage.value, showTranslation.value)
}

async function finishBatch() {
  if (session.value) await completeReadingSession(session.value.sessionId)
  stage.value = 2
  if (session.value) await saveReadingProgress(session.value.sessionId, stage.value, showTranslation.value)
}

async function toggleTranslation() {
  showTranslation.value = !showTranslation.value
  if (session.value) await saveReadingProgress(session.value.sessionId, stage.value, showTranslation.value)
}

async function regenerate() {
  if (!session.value) return
  await saveReadingProgress(session.value.sessionId, 0, false)
  await resetReadingSessionAttempts(session.value.sessionId)
  results.value = {}
  stage.value = 0
  showTranslation.value = false
  hadRetry.value = false
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
  if (session.value) await saveReadingProgress(session.value.sessionId, stage.value, showTranslation.value)
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
      <div class="reading-title-row"><h1>{{ session.title }}</h1><button class="btn btn-quiet" type="button" @click="regenerate">重新生成</button></div>
      <div ref="readingCopy" class="reading-copy reading-copy-selectable"><template v-for="(segment, index) in parsed.segments" :key="index"><mark v-if="stage >= 1 && segment.wordId" class="target-word">{{ segment.text }}</mark><span v-else>{{ segment.text }}</span></template></div>
      <button v-if="stage === 0" class="btn btn-primary" type="button" @click="revealTargets">我已读完，标出目标词</button>
      <section v-if="stage >= 1" class="quiz-list">
        <article v-for="target in parsed.targets" :key="target.wordId" class="entry-card">
          <h2>{{ target.headword }}</h2>
          <div v-if="!results[target.wordId]" class="context-choice-list">
            <button v-for="choice in target.choices" :key="choice" class="btn" type="button" @click="answer(target, choice)">{{ choice }}</button>
            <button class="btn btn-quiet" type="button" @click="answer(target)">不确定</button>
          </div>
          <div v-else :class="['context-answer', results[target.wordId] === 'correct' ? 'correct' : 'incorrect']"><strong>{{ results[target.wordId] === 'correct' ? '回答正确' : results[target.wordId] === 'uncertain' ? '不确定' : '回答错误' }}</strong><p>答案：{{ target.contextualMeaning }}</p><p>{{ target.explanation }}</p></div>
        </article>
      </section>
      <button v-if="stage === 1 && allAnswered" class="btn btn-primary" type="button" @click="finishBatch">完成本篇</button>
      <template v-if="stage === 2">
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
