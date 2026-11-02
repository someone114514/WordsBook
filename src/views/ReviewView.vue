<script setup lang="ts">
import { t, studyListName } from '../i18n'
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
const latestReadingCountLabel = computed(() => latestReading.value?.errorCode ? t("预习词") : t("目标词"))

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
const supportingMetricLabel = computed(() => snapshot.value ? t("待重现") : t("复习"))
const supportingMetricValue = computed(() => snapshot.value ? repeatCards.value : plan.value?.dueCount ?? 0)
const primaryActionIsLookup = computed(() => hasLoaded.value && !session.value && total.value === 0)
const buttonLabel = computed(() => {
  if (primaryActionIsLookup.value) return t("去查词")
  if (session.value?.status === 'completed') return t("查看今日学习")
  return session.value ? t("继续今日学习") : t("开始今日学习")
})
const recoveryText = computed(() => {
  if (session.value?.recoveryMode) {
    const count = session.value.recoveryCalibrationCount ?? 0
    const accuracy = session.value.recoveryAccuracy
    const calibration = count
      ? t("已校准 {0}/15{1}", [count, accuracy === undefined ? '' : t("，首次提取正确率 {0}%", [Math.round(accuracy * 100)])])
      : t("先用 15 个分层到期词校准")
    return t("恢复模式：今日包受上限保护，预计 {0} 天消化；{1}。", [session.value.recoveryDays ?? 3, calibration])
  }
  if (plan.value?.recoveryMode) {
    return t("恢复模式：共 {0} 个到期词，今日安排 {1} 个，预计 {2} 天消化；先完成 15 词校准，暂缓新词。", [plan.value.backlogDueCount ?? plan.value.dueCount, plan.value.dueCount, plan.value.recoveryDays ?? 3])
  }
  const days = plan.value?.daysSinceLastStudy ?? 0
  if (days < 2) return ''
  return t("间隔 {0} 天，预计用 {1} 天恢复；今天先处理最需要回忆的词。", [days, plan.value?.recoveryDays ?? 1])
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
      ? t("已按最新词表与新词额度重排未开始内容。")
      : t("已按最新新词额度重排今日学习。")
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
      <p class="error" role="alert">{{ error }}</p><button class="btn btn-primary" type="button" @click="load">{{ t("重试") }}</button>
    </section>

    <section class="study-hero" :aria-busy="loading">
      <div class="study-total">
        <span v-if="loading" class="study-number-skeleton study-number-skeleton-total" role="status" :aria-label="t('剩余单词数量加载中')" />
        <strong v-else>{{ total }}</strong>
        <span>{{ t("剩余单词") }}</span>
      </div>
      <div class="study-metrics-inline" :aria-label="t('今日学习概况')">
        <span><strong>{{ loading ? '—' : todayTotal }}</strong>{{ t("今日总量") }}</span>
        <span><strong>{{ loading ? '—' : todayNew }}</strong>{{ t("新词") }}</span>
        <span><strong>{{ loading ? '—' : supportingMetricValue }}</strong> {{ supportingMetricLabel }}</span>
      </div>
      <details v-if="!loading && recoveryText" class="study-inline-disclosure">
        <summary>{{ t("恢复安排") }}</summary>
        <p>{{ recoveryText }}</p>
      </details>
      <p v-if="!loading && refreshingPlan" class="study-plan-refresh" aria-live="polite">{{ t("正在后台更新今日计划…") }}</p>
      <details v-if="session && !loading" class="study-more-actions">
        <summary>{{ t("更多操作") }}</summary>
        <button class="btn btn-quiet study-queue-replan" :disabled="changeBusy" type="button" @click="replanUnstarted">
          {{ changeBusy ? t("重排中…") : t("重排未开始内容") }}
        </button>
      </details>
      <span v-if="replanMessage" class="muted study-replan-message" role="status">{{ replanMessage }}</span>
    </section>

    <template v-if="hasLoaded && !error">

      <section v-if="visibleQueueChanges" class="queue-change-panel" aria-live="polite">
        <strong>{{ t("词表有 {0} 项变化", [visibleQueueChanges]) }}</strong>
        <div class="actions"><button class="btn btn-text" :disabled="changeBusy" type="button" @click="applyChanges">{{ t("更新") }}</button><button class="btn btn-text muted" type="button" @click="dismissChanges">{{ t("稍后") }}</button></div>
      </section>
      <button v-else-if="dismissedQueueChanges" class="btn btn-text queue-change-restore" type="button" @click="queueChanges = queueChanges ? { ...queueChanges, dismissed: false } : null">{{ t("查看词表变化") }}</button>

      <section v-if="latestReading" class="reading-resume-panel">
        <RouterLink class="reading-resume-row" :to="canResumeLatestReading ? { path: '/review/reading', query: { session: `daily:${latestReading.dayKey}`, batch: latestReading.batchIndex } } : '/review/reading/history'">
          <span><small>{{ latestReading.errorCode ? t("离线预习") : t("语境阅读") }}</small><strong>{{ latestReading.errorCode ? t("离线词汇预习") : latestReading.title || t("已生成的文章") }}</strong><small>{{ t("{0} · {1} 个{2}", [latestReading.dayKey, latestReadingWordCount, latestReadingCountLabel]) }}</small></span>
          <span class="reading-resume-action">{{ canResumeLatestReading ? t("继续") : t("查看") }}</span>
        </RouterLink>
        <RouterLink class="btn btn-text reading-history-link" to="/review/reading/history">{{ t("文章记录") }}</RouterLink>
      </section>

      <details v-if="!snapshot" class="study-source-disclosure">
        <summary><span>{{ t("今日来源") }}</span><span>{{ plan?.listContributions?.length ? t("{0} 个词表", [plan.listContributions.length]) : t("暂无内容") }}</span></summary>
        <div v-if="plan?.listContributions?.length" class="contribution-list">
          <div v-for="item in plan.listContributions" :key="item.listId"><span>{{ studyListName(item) }}</span><strong>{{ t("{0} 词", [item.count]) }}</strong></div>
        </div>
        <p v-else class="muted">{{ t("还没有参与学习的单词。") }}</p>
        <RouterLink class="btn btn-text" to="/lists">{{ t("管理词表") }}</RouterLink>
      </details>
    </template>

    <div class="study-primary-dock">
      <button class="btn btn-primary study-primary" :disabled="!hasLoaded" type="button" @click="start">{{ hasLoaded ? buttonLabel : t("正在准备今日学习…") }}</button>
    </div>
  </main>
</template>
