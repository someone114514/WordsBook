<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { db } from '../db/database'
import type { ContextAttempt, PracticeQuestion, ReadingSession } from '../types/models'
import {
  completeRoundPractice,
  generateRoundPractice,
  loadPracticeQuestions,
  recordPracticeAnswer,
  retryRoundPractice,
} from '../modules/reading/practiceService'
import { resumeDailyCardsAfterPractice } from '../modules/review/dailyQueueService'

const route = useRoute()
const router = useRouter()
const dailySessionId = computed(() => typeof route.query.session === 'string' ? route.query.session : '')
const content = ref<ReadingSession | null>(null)
const questions = ref<PracticeQuestion[]>([])
const attempts = ref<Record<string, ContextAttempt>>({})
const cursor = ref(0)
const busy = ref(false)
const error = ref('')
let pollTimer = 0

const current = computed(() => questions.value[cursor.value])
const currentAttempt = computed(() => current.value ? attempts.value[current.value.questionId] : undefined)
const statusText = computed(() => content.value?.status === 'failed'
  ? '语境练习生成失败'
  : content.value?.status === 'ready' || content.value?.status === 'completed'
    ? '' : '正在准备语境练习…')

async function refresh() {
  const daily = await db.dailyLearningSessions.get(dailySessionId.value)
  const sessionId = daily?.pendingPracticeSessionId
  if (!daily || !sessionId) {
    await router.replace('/review/session')
    return
  }
  content.value = await db.readingSessions.get(sessionId) ?? null
  if (!content.value) {
    error.value = '语境练习记录不存在，可跳过后继续学习。'
    return
  }
  if (content.value.status === 'pending' || content.value.status === 'streaming') {
    void generateRoundPractice(content.value.sessionId)
    return
  }
  if (content.value.status === 'ready' || content.value.status === 'completed') {
    questions.value = await loadPracticeQuestions(content.value.sessionId)
    const rows = await db.contextAttempts.where('sessionId').equals(content.value.sessionId).toArray()
    attempts.value = Object.fromEntries(rows.flatMap((attempt) => attempt.questionId ? [[attempt.questionId, attempt]] : []))
    const unanswered = questions.value.findIndex((question) => !attempts.value[question.questionId])
    cursor.value = unanswered >= 0 ? unanswered : Math.max(0, questions.value.length - 1)
  }
}

async function answer(index?: number) {
  if (!content.value || !current.value || busy.value) return
  busy.value = true
  try {
    const attempt = await recordPracticeAnswer(
      content.value.sessionId,
      current.value,
      index,
      dailySessionId.value,
      content.value.batchIndex,
    )
    attempts.value[current.value.questionId] = attempt
  } finally { busy.value = false }
}

async function next() {
  if (!currentAttempt.value) return
  if (cursor.value + 1 < questions.value.length) {
    cursor.value += 1
    return
  }
  await finish(false)
}

async function finish(skipped: boolean) {
  if (busy.value) return
  busy.value = true
  try {
    if (content.value) await completeRoundPractice(content.value.sessionId, skipped)
    const snapshot = await resumeDailyCardsAfterPractice(dailySessionId.value)
    if (snapshot.session.phase === 'article') {
      await router.replace({ path: '/review/reading', query: { session: dailySessionId.value } })
    } else {
      await router.replace(snapshot.session.status === 'completed' ? '/review' : '/review/session')
    }
  } finally { busy.value = false }
}

async function retry() {
  if (!content.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    content.value = await retryRoundPractice(content.value.sessionId)
    await refresh()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally { busy.value = false }
}

onMounted(async () => {
  await refresh()
  pollTimer = window.setInterval(() => {
    if (content.value?.status === 'pending' || content.value?.status === 'streaming') void refresh()
  }, 800)
})
onBeforeUnmount(() => window.clearInterval(pollTimer))
</script>

<template>
  <main class="immersive-shell practice-session-page">
    <header class="immersive-header">
      <div class="immersive-progress"><span>语境练习</span><strong>{{ questions.length ? `${cursor + 1} / ${questions.length}` : '准备中' }}</strong></div>
      <button class="btn btn-quiet" type="button" :disabled="busy" @click="finish(true)">跳过</button>
    </header>

    <section v-if="!content || content.status === 'pending' || content.status === 'streaming'" class="immersive-card practice-loading" aria-live="polite">
      <div class="skeleton-lines" aria-hidden="true"><span/><span/><span/></div>
      <h1>{{ statusText }}</h1>
      <p v-if="error" class="error">{{ error }}</p>
      <p v-else>任务已经保存；退出或刷新后会继续恢复。</p>
      <button class="btn" type="button" :disabled="busy" @click="finish(true)">跳过本次</button>
    </section>

    <section v-else-if="content.status === 'failed'" class="immersive-card empty-state">
      <h1>语境练习生成失败</h1>
      <p class="error">{{ error || content.error }}</p>
      <div class="action-row"><button class="btn btn-primary" type="button" :disabled="busy" @click="retry">{{ busy ? '重试中…' : '手动重试' }}</button><button class="btn" type="button" @click="finish(true)">跳过本次</button></div>
    </section>

    <section v-else-if="current" class="immersive-card practice-question-card">
      <p class="eyebrow">{{ current.type === 'meaning-in-context' ? '英文释义辨析' : '四语境辨用法' }}</p>
      <h1>{{ current.headword }}</h1>
      <p v-if="current.passage" class="practice-passage">{{ current.passage }}</p>
      <h2>{{ current.stem }}</h2>
      <div class="context-choice-list">
        <button v-for="(option, index) in current.options" :key="option" class="btn" type="button" :disabled="busy || Boolean(currentAttempt)" @click="answer(index)">{{ String.fromCharCode(65 + index) }}. {{ option }}</button>
        <button v-if="!currentAttempt" class="btn btn-quiet" type="button" :disabled="busy" @click="answer()">不确定</button>
      </div>
      <div v-if="currentAttempt" :class="['context-answer', currentAttempt.result === 'correct' ? 'correct' : 'incorrect']">
        <strong>{{ currentAttempt.result === 'correct' ? '回答正确' : currentAttempt.result === 'uncertain' ? '不确定' : '回答错误' }}</strong>
        <p>答案：{{ current.options[current.correctIndex] }}</p>
        <p>{{ current.explanation }}</p>
        <ul><li v-for="clue in current.evidence" :key="clue">{{ clue }}</li></ul>
        <details><summary>查看选项辨析</summary><p v-for="(reason, index) in current.distractorExplanations" :key="index">{{ String.fromCharCode(65 + index) }}. {{ reason }}</p></details>
      </div>
      <button v-if="currentAttempt" class="btn btn-primary" type="button" @click="next">{{ cursor + 1 < questions.length ? '下一题' : '继续学习' }}</button>
    </section>
  </main>
</template>
