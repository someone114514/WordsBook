<script setup lang="ts">
import dayjs from 'dayjs'
import { liveQuery } from 'dexie'
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { describeLearningError } from '../app/userFacingErrors'
import { db } from '../db/database'
import type { DailyLearningSession, ReadingSession, StudyPlan } from '../types/models'
import { getTodayPlanStaleWhileRevalidate, STUDY_PLAN_REFRESHED_EVENT } from '../modules/review/reviewService'
import { listReadingHistory } from '../modules/reading/readingService'
import {
  applyDailyQueueChanges,
  dismissDailyQueueChanges,
  loadDailyQueueSnapshot,
  previewDailyQueueChanges,
  replanUnstartedDailyQueue,
  type DailyQueueChangePreview,
  type DailyQueueSnapshot,
} from '../modules/review/dailyQueueService'

const router = useRouter()
const loading = ref(true)
const hasLoaded = ref(false)
const error = ref('')
const plan = ref<StudyPlan | null>(null)
const refreshingPlan = ref(false)
const session = ref<DailyLearningSession | null>(null)
const snapshot = ref<DailyQueueSnapshot | null>(null)
const queueChanges = ref<DailyQueueChangePreview | null>(null)
const changeBusy = ref(false)
const replanMessage = ref('')
const readingHistory = ref<ReadingSession[]>([])
let liveSubscription: { unsubscribe(): void } | undefined
let viewActive = false
let loadToken = 0
const latestReading = computed(() => readingHistory.value[0] ?? null)
const canResumeLatestReading = computed(() => latestReading.value?.dayKey === dayjs().format('YYYY-MM-DD'))
const latestReadingWordCount = computed(() => latestReading.value?.targetWordIds.length
  || latestReading.value?.sourceWordIds?.length
  || 0)
const latestReadingCountLabel = computed(() => latestReading.value?.errorCode ? '预习词' : '目标词')

const sessionNewCount = computed(() => {
  const firstItems = new Map<string, boolean>()
  for (const item of snapshot.value?.items ?? []) {
    if (item.status === 'skipped') continue
    if (item.wordId && !firstItems.has(item.wordId)) firstItems.set(item.wordId, Boolean(item.wasNew))
  }
  return [...firstItems.values()].filter(Boolean).length
})
const remainingCards = computed(() => new Set(snapshot.value?.items
  .filter((item) => item.kind === 'card' && item.wordId && (item.status === 'pending' || item.status === 'active'))
  .map((item) => item.wordId)).size)
const total = computed(() => snapshot.value
  ? remainingCards.value
  : plan.value?.queueWordIds.length ?? 0)
const repeatCards = computed(() => snapshot.value?.items.filter((item) => item.kind === 'card'
  && (item.status === 'pending' || item.status === 'active')
  && (item.attemptNo > 1 || item.reason === 'context-retry')).length ?? 0)
const visibleQueueChanges = computed(() => queueChanges.value && !queueChanges.value.dismissed
  ? queueChanges.value.addedWordIds.length + queueChanges.value.removedWordIds.length
  : 0)
const dismissedQueueChanges = computed(() => queueChanges.value?.dismissed
  ? queueChanges.value.addedWordIds.length + queueChanges.value.removedWordIds.length
  : 0)
const todayTotal = computed(() => snapshot.value?.totalCards ?? plan.value?.queueWordIds.length ?? 0)
const todayNew = computed(() => snapshot.value ? sessionNewCount.value : plan.value?.newCount ?? 0)
const supportingMetricLabel = computed(() => snapshot.value ? '待重现' : '复习')
const supportingMetricValue = computed(() => snapshot.value ? repeatCards.value : plan.value?.dueCount ?? 0)
const primaryActionIsLookup = computed(() => hasLoaded.value && !session.value && total.value === 0)
const buttonLabel = computed(() => {
  if (primaryActionIsLookup.value) return '去查词'
  if (session.value?.status === 'completed') return '查看今日学习'
  return session.value ? '继续今日学习' : '开始今日学习'
})
const recoveryText = computed(() => {
  if (session.value?.recoveryMode) {
    const count = session.value.recoveryCalibrationCount ?? 0
    const accuracy = session.value.recoveryAccuracy
    const calibration = count
      ? `已校准 ${count}/15${accuracy === undefined ? '' : `，首次提取正确率 ${Math.round(accuracy * 100)}%`}`
      : '先用 15 个分层到期词校准'
    return `恢复模式：今日包受上限保护，预计 ${session.value.recoveryDays ?? 3} 天消化；${calibration}。`
  }
  if (plan.value?.recoveryMode) {
    return `恢复模式：共 ${plan.value.backlogDueCount ?? plan.value.dueCount} 个到期词，今日安排 ${plan.value.dueCount} 个，预计 ${plan.value.recoveryDays ?? 3} 天消化；先完成 15 词校准，暂缓新词。`
  }
  const days = plan.value?.daysSinceLastStudy ?? 0
  if (days < 2) return ''
  return `间隔 ${days} 天，预计用 ${plan.value?.recoveryDays ?? 1} 天恢复；今天先处理最需要回忆的词。`
})

function stopSessionSubscription() {
  liveSubscription?.unsubscribe()
  liveSubscription = undefined
}

function subscribeToSession(sessionId: string) {
  stopSessionSubscription()
  liveSubscription = liveQuery(() => loadDailyQueueSnapshot(sessionId)).subscribe({
    next: (fresh) => {
      if (session.value?.sessionId !== sessionId) return
      const currentRevision = snapshot.value?.session.sessionRevision ?? 0
      const incomingRevision = fresh.session.sessionRevision ?? 0
      if (incomingRevision < currentRevision) return
      snapshot.value = fresh
      session.value = fresh.session
    },
    error: (reason) => {
      error.value = describeLearningError(reason, 'overview')
    },
  })
}

async function load() {
  const token = ++loadToken
  loading.value = !hasLoaded.value
  error.value = ''
  stopSessionSubscription()
  try {
    session.value = await db.dailyLearningSessions.where('dayKey').equals(dayjs().format('YYYY-MM-DD')).first() ?? null
    if (token !== loadToken) return
    if (session.value) {
      plan.value = null
      readingHistory.value = await listReadingHistory()
      if (token !== loadToken) return
    } else {
      const [planResult, history] = await Promise.all([getTodayPlanStaleWhileRevalidate(), listReadingHistory()])
      if (token !== loadToken) return
      plan.value = planResult.plan
      readingHistory.value = history
      refreshingPlan.value = planResult.stale
      void planResult.refreshPromise?.finally(() => { refreshingPlan.value = false })
    }
    if (session.value) {
      const [loadedSnapshot, changes] = await Promise.all([
        loadDailyQueueSnapshot(session.value.sessionId),
        previewDailyQueueChanges(session.value.sessionId),
      ])
      if (token !== loadToken) return
      snapshot.value = loadedSnapshot
      queueChanges.value = changes
      if (!changes.addedWordIds.length && !changes.removedWordIds.length && changes.revision !== session.value.sourceRevision) {
        snapshot.value = await applyDailyQueueChanges(session.value.sessionId)
        if (token !== loadToken) return
        session.value = snapshot.value.session
      }
      if (viewActive && token === loadToken) subscribeToSession(session.value.sessionId)
    } else {
      snapshot.value = null
      queueChanges.value = null
    }
  } catch (reason) {
    error.value = describeLearningError(reason, 'overview')
  } finally {
    if (token === loadToken) {
      loading.value = false
      hasLoaded.value = true
    }
  }
}

function onPlanRefreshed(event: Event) {
  if (session.value) return
  const refreshed = (event as CustomEvent<StudyPlan>).detail
  if (refreshed) plan.value = refreshed
  refreshingPlan.value = false
}

async function start() {
  if (primaryActionIsLookup.value) {
    await router.push('/lookup')
    return
  }
  await router.push('/review/session')
}

async function applyChanges() {
  if (!session.value) return
  changeBusy.value = true
  try { await applyDailyQueueChanges(session.value.sessionId); await load() }
  finally { changeBusy.value = false }
}

async function replanUnstarted() {
  if (!session.value || changeBusy.value) return
  changeBusy.value = true
  replanMessage.value = ''
  try {
    const updated = await replanUnstartedDailyQueue(session.value.sessionId)
    snapshot.value = updated
    session.value = updated.session
    queueChanges.value = await previewDailyQueueChanges(updated.session.sessionId)
    replanMessage.value = updated.attempts.length
      ? '已按最新词表与新词额度重排未开始内容。'
      : '已按最新新词额度重排今日学习。'
  } finally {
    changeBusy.value = false
  }
}

async function dismissChanges() {
  if (!session.value || !queueChanges.value) return
  await dismissDailyQueueChanges(session.value.sessionId, queueChanges.value.revision)
  queueChanges.value = { ...queueChanges.value, dismissed: true }
}

onActivated(() => {
  viewActive = true
  void load()
})
onDeactivated(() => {
  viewActive = false
  loadToken += 1
  stopSessionSubscription()
})
onMounted(() => window.addEventListener(STUDY_PLAN_REFRESHED_EVENT, onPlanRefreshed))
onBeforeUnmount(() => {
  viewActive = false
  loadToken += 1
  stopSessionSubscription()
  window.removeEventListener(STUDY_PLAN_REFRESHED_EVENT, onPlanRefreshed)
})
</script>

<template>
  <main class="page-shell study-home">
    <section v-if="error" class="panel empty-state">
      <p class="error" role="alert">{{ error }}</p><button class="btn btn-primary" type="button" @click="load">重试</button>
    </section>

    <section class="study-hero" :aria-busy="loading">
      <div class="study-total">
        <span v-if="loading" class="study-number-skeleton study-number-skeleton-total" role="status" aria-label="剩余单词数量加载中" />
        <strong v-else>{{ total }}</strong>
        <span>剩余单词</span>
      </div>
      <div class="study-metrics-inline" aria-label="今日学习概况">
        <span><strong>{{ loading ? '—' : todayTotal }}</strong> 今日总量</span>
        <span><strong>{{ loading ? '—' : todayNew }}</strong> 新词</span>
        <span><strong>{{ loading ? '—' : supportingMetricValue }}</strong> {{ supportingMetricLabel }}</span>
      </div>
      <details v-if="!loading && recoveryText" class="study-inline-disclosure">
        <summary>恢复安排</summary>
        <p>{{ recoveryText }}</p>
      </details>
      <p v-if="!loading && refreshingPlan" class="study-plan-refresh" aria-live="polite">正在后台更新今日计划…</p>
      <details v-if="session && !loading" class="study-more-actions">
        <summary>更多操作</summary>
        <button class="btn btn-quiet study-queue-replan" :disabled="changeBusy" type="button" @click="replanUnstarted">
          {{ changeBusy ? '重排中…' : '重排未开始内容' }}
        </button>
      </details>
      <span v-if="replanMessage" class="muted study-replan-message" role="status">{{ replanMessage }}</span>
    </section>

    <template v-if="hasLoaded && !error">

      <section v-if="visibleQueueChanges" class="queue-change-panel" aria-live="polite">
        <strong>词表有 {{ visibleQueueChanges }} 项变化</strong>
        <div class="actions"><button class="btn btn-text" :disabled="changeBusy" type="button" @click="applyChanges">更新</button><button class="btn btn-text muted" type="button" @click="dismissChanges">稍后</button></div>
      </section>
      <button v-else-if="dismissedQueueChanges" class="btn btn-text queue-change-restore" type="button" @click="queueChanges = queueChanges ? { ...queueChanges, dismissed: false } : null">查看词表变化</button>

      <section v-if="latestReading" class="reading-resume-panel">
        <RouterLink class="reading-resume-row" :to="canResumeLatestReading ? { path: '/review/reading', query: { session: `daily:${latestReading.dayKey}`, batch: latestReading.batchIndex } } : '/review/reading/history'">
          <span><small>{{ latestReading.errorCode ? '离线预习' : '语境阅读' }}</small><strong>{{ latestReading.errorCode ? '离线词汇预习' : latestReading.title || '已生成的文章' }}</strong><small>{{ latestReading.dayKey }} · {{ latestReadingWordCount }} 个{{ latestReadingCountLabel }}</small></span>
          <span class="reading-resume-action">{{ canResumeLatestReading ? '继续' : '查看' }}</span>
        </RouterLink>
        <RouterLink class="btn btn-text reading-history-link" to="/review/reading/history">文章记录</RouterLink>
      </section>

      <details v-if="!snapshot" class="study-source-disclosure">
        <summary><span>今日来源</span><span>{{ plan?.listContributions?.length ? `${plan.listContributions.length} 个词表` : '暂无内容' }}</span></summary>
        <div v-if="plan?.listContributions?.length" class="contribution-list">
          <div v-for="item in plan.listContributions" :key="item.listId"><span>{{ item.name }}</span><strong>{{ item.count }} 词</strong></div>
        </div>
        <p v-else class="muted">还没有参与学习的单词。</p>
        <RouterLink class="btn btn-text" to="/lists">管理词表</RouterLink>
      </details>
    </template>

    <div class="study-primary-dock">
      <button class="btn btn-primary study-primary" :disabled="!hasLoaded" type="button" @click="start">{{ hasLoaded ? buttonLabel : '正在准备今日学习…' }}</button>
    </div>
  </main>
</template>
