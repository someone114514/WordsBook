<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
import { setWakeLockOwner } from '../app/screenWakeLock'

const route = useRoute()
const router = useRouter()
const dailySessionId = computed(() => typeof route.query.session === 'string' ? route.query.session : '')
const content = ref<ReadingSession | null>(null)
const questions = ref<PracticeQuestion[]>([])
const attempts = ref<Record<string, ContextAttempt>>({})
const cursor = ref(0)
const busy = ref(false)
const error = ref('')
const selfRecallRevealed = ref(false)
let pollTimer = 0
let questionShownAt = Date.now()
let generationInFlight = false
let disposed = false

const current = computed(() => questions.value[cursor.value])
const currentAttempt = computed(() => current.value ? attempts.value[current.value.questionId] : undefined)
const statusText = computed(() => content.value?.status === 'failed'
  ? '语境练习生成失败'
  : content.value?.status === 'ready' || content.value?.status === 'completed'
    ? '' : '正在准备语境练习…')
const questionKindLabel = computed(() => current.value?.type === 'meaning-in-context'
  ? '英文释义辨析'
  : current.value?.type === 'usage-discrimination' ? '四语境辨用法' : '本地主动回忆')
const failureKind = computed(() => {
  switch (content.value?.errorCode) {
    case 'contract-invalid': return '题目结构或词义绑定未通过校验'
    case 'invalid-json': return 'AI 返回内容不是有效 JSON'
    case 'timeout': return 'AI 请求超过总等待时间'
    case 'network': return '当前设备无法连接 AI 服务'
    case 'unauthorized':
    case 'auth': return 'API Key 无效或无权访问当前模型'
    case 'quota': return 'API 账户余额不足'
    case 'rate-limited':
    case 'rate-limit': return 'AI 服务请求频率受限'
    case 'server': return 'AI 服务端暂时异常'
    case 'missing-key': return '当前设备未配置 API Key'
    default: return 'AI 生成未成功'
  }
})

watch(() => current.value?.questionId, () => {
  questionShownAt = Date.now()
  selfRecallRevealed.value = false
})

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
  if (content.value.status === 'failed' || content.value.status === 'skipped') {
    // Practice is an optional enhancement. Contract, network and credential
    // failures must never strand the learner on a dead-end screen.
    await finish(true)
    return
  }
  if (content.value.status === 'pending' || content.value.status === 'streaming') {
    if (!generationInFlight) {
      generationInFlight = true
      void generateRoundPractice(content.value.sessionId)
        .then(() => {
          if (!disposed) return refresh()
        })
        .catch((reason) => {
          if (disposed) return
          error.value = reason instanceof Error ? reason.message : String(reason)
          window.clearInterval(pollTimer)
        })
        .finally(() => { generationInFlight = false })
    }
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
      { responseMs: Math.max(0, Date.now() - questionShownAt), hintLevel: current.value.hintLevel ?? 0 },
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

async function retryAiPractice() {
  if (!content.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    content.value = await retryRoundPractice(content.value.sessionId)
    questions.value = await loadPracticeQuestions(content.value.sessionId)
    const unanswered = questions.value.findIndex((question) => !attempts.value[question.questionId])
    cursor.value = unanswered >= 0 ? unanswered : 0
    selfRecallRevealed.value = false
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    busy.value = false
  }
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

onMounted(async () => {
  await refresh()
  void setWakeLockOwner('practice-session', true)
  document.addEventListener('visibilitychange', refreshPracticeAfterResume)
  pollTimer = window.setInterval(() => {
    if (content.value?.status === 'pending' || content.value?.status === 'streaming') void refresh()
  }, 800)
})
onBeforeUnmount(() => {
  disposed = true
  window.clearInterval(pollTimer)
  document.removeEventListener('visibilitychange', refreshPracticeAfterResume)
  void setWakeLockOwner('practice-session', false)
})

function refreshPracticeAfterResume(): void {
  if (document.visibilityState !== 'visible') return
  disposed = false
  void setWakeLockOwner('practice-session', true)
  void refresh()
}
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

    <section v-else-if="current" class="immersive-card practice-question-card">
      <p class="eyebrow">{{ questionKindLabel }}</p>
      <div v-if="content?.errorCode" class="practice-fallback-notice">
        <div>
          <p class="muted">AI 增强当前未成功，已保留可完成的本地练习。</p>
          <small>{{ failureKind }}</small>
          <details v-if="content.error"><summary>查看技术原因</summary><p>{{ content.error }}</p></details>
        </div>
        <button class="btn btn-quiet" type="button" :disabled="busy" @click="retryAiPractice">重新生成 AI 练习</button>
      </div>
      <h1>{{ current.headword }}</h1>
      <p v-if="current.passage" class="practice-passage">{{ current.passage }}</p>
      <h2>{{ current.stem }}</h2>
      <div v-if="current.type === 'self-recall' && !selfRecallRevealed && !currentAttempt" class="context-choice-list">
        <button class="btn btn-primary" type="button" @click="selfRecallRevealed = true">查看答案并自评</button>
      </div>
      <div v-else-if="current.type === 'self-recall' && !currentAttempt" class="local-recall-answer">
        <div class="context-answer"><strong>核心义</strong><p>{{ current.sourceSense }}</p><ul><li v-for="clue in current.evidence.slice(1)" :key="clue">{{ clue }}</li></ul></div>
        <div class="context-choice-list">
          <button class="btn btn-primary" type="button" :disabled="busy" @click="answer(0)">想起来了</button>
          <button class="btn" type="button" :disabled="busy" @click="answer(1)">还没想起来</button>
          <button class="btn btn-quiet" type="button" :disabled="busy" @click="answer()">不确定</button>
        </div>
      </div>
      <div v-else-if="current.type !== 'self-recall'" class="context-choice-list">
        <button v-for="(option, index) in current.options" :key="option" class="btn" type="button" :disabled="busy || Boolean(currentAttempt)" @click="answer(index)">{{ String.fromCharCode(65 + index) }}. {{ option }}</button>
        <button v-if="!currentAttempt" class="btn btn-quiet" type="button" :disabled="busy" @click="answer()">不确定</button>
      </div>
      <div v-if="currentAttempt" :class="['context-answer', currentAttempt.result === 'correct' ? 'correct' : 'incorrect']">
        <strong>{{ current.type === 'self-recall' ? '自评完成' : currentAttempt.result === 'correct' ? '回答正确' : currentAttempt.result === 'uncertain' ? '不确定' : '回答错误' }}</strong>
        <p v-if="current.type !== 'self-recall'">答案：{{ current.options[current.correctIndex] }}</p>
        <p>{{ current.explanation }}</p>
        <ul><li v-for="clue in current.evidence" :key="clue">{{ clue }}</li></ul>
        <details v-if="current.rationalesAligned && current.distractorExplanations.some(Boolean)"><summary>查看选项辨析</summary><p v-for="(reason, index) in current.distractorExplanations" v-show="reason" :key="index">{{ String.fromCharCode(65 + index) }}. {{ reason }}</p></details>
      </div>
      <button v-if="currentAttempt" class="btn btn-primary" type="button" @click="next">{{ cursor + 1 < questions.length ? '下一题' : '继续学习' }}</button>
    </section>
  </main>
</template>
