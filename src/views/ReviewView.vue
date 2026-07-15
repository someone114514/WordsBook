<script setup lang="ts">
import dayjs from 'dayjs'
import { computed, onActivated, ref } from 'vue'
import { useRouter } from 'vue-router'
import { db } from '../db/database'
import type { DailyLearningSession, ReadingSession, StudyPlan } from '../types/models'
import { buildTodayPlanCached } from '../modules/review/reviewService'
import { listReadingHistory } from '../modules/reading/readingService'
import {
  applyDailyQueueChanges,
  dismissDailyQueueChanges,
  loadDailyQueueSnapshot,
  previewDailyQueueChanges,
  type DailyQueueChangePreview,
  type DailyQueueSnapshot,
} from '../modules/review/dailyQueueService'

const router = useRouter()
const loading = ref(true)
const hasLoaded = ref(false)
const error = ref('')
const plan = ref<StudyPlan | null>(null)
const session = ref<DailyLearningSession | null>(null)
const remainingCards = ref(0)
const snapshot = ref<DailyQueueSnapshot | null>(null)
const queueChanges = ref<DailyQueueChangePreview | null>(null)
const changeBusy = ref(false)
const readingHistory = ref<ReadingSession[]>([])
const latestReading = computed(() => readingHistory.value[0] ?? null)
const canResumeLatestReading = computed(() => latestReading.value?.dayKey === dayjs().format('YYYY-MM-DD'))

const total = computed(() => snapshot.value
  ? snapshot.value.totalCards
  : plan.value?.queueWordIds.length ?? 0)
const sessionNewCount = computed(() => {
  const firstItems = new Map<string, boolean>()
  for (const item of snapshot.value?.items ?? []) {
    if (item.wordId && !firstItems.has(item.wordId)) firstItems.set(item.wordId, Boolean(item.wasNew))
  }
  return [...firstItems.values()].filter(Boolean).length
})
const visibleQueueChanges = computed(() => queueChanges.value && !queueChanges.value.dismissed
  ? queueChanges.value.addedWordIds.length + queueChanges.value.removedWordIds.length
  : 0)
const dismissedQueueChanges = computed(() => queueChanges.value?.dismissed
  ? queueChanges.value.addedWordIds.length + queueChanges.value.removedWordIds.length
  : 0)
const buttonLabel = computed(() => {
  if (session.value?.status === 'completed') return '查看今日学习'
  return session.value ? '继续今日学习' : '开始今日学习'
})
const recoveryText = computed(() => {
  const days = plan.value?.daysSinceLastStudy ?? 0
  if (days < 2) return ''
  return `间隔 ${days} 天，预计用 ${plan.value?.recoveryDays ?? 1} 天恢复；今天先处理最需要回忆的词。`
})

async function load() {
  loading.value = true
  error.value = ''
  try {
    session.value = await db.dailyLearningSessions.where('dayKey').equals(dayjs().format('YYYY-MM-DD')).first() ?? null
    if (session.value) {
      plan.value = null
      readingHistory.value = await listReadingHistory()
    } else {
      ;[plan.value, readingHistory.value] = await Promise.all([buildTodayPlanCached(), listReadingHistory()])
    }
    if (session.value) {
      const [loadedSnapshot, changes] = await Promise.all([
        loadDailyQueueSnapshot(session.value.sessionId),
        previewDailyQueueChanges(session.value.sessionId),
      ])
      snapshot.value = loadedSnapshot
      queueChanges.value = changes
      if (!changes.addedWordIds.length && !changes.removedWordIds.length && changes.revision !== session.value.sourceRevision) {
        snapshot.value = await applyDailyQueueChanges(session.value.sessionId)
        session.value = snapshot.value.session
      }
      remainingCards.value = loadedSnapshot.items.filter((item) => item.kind === 'card' && (item.status === 'pending' || item.status === 'active')).length
    } else {
      remainingCards.value = 0
      snapshot.value = null
      queueChanges.value = null
    }
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    loading.value = false
    hasLoaded.value = true
  }
}

async function start() {
  await router.push('/review/session')
}

async function applyChanges() {
  if (!session.value) return
  changeBusy.value = true
  try { await applyDailyQueueChanges(session.value.sessionId); await load() }
  finally { changeBusy.value = false }
}

async function dismissChanges() {
  if (!session.value || !queueChanges.value) return
  await dismissDailyQueueChanges(session.value.sessionId, queueChanges.value.revision)
  queueChanges.value = { ...queueChanges.value, dismissed: true }
}

onActivated(() => {
  void load()
})
</script>

<template>
  <main class="page-shell study-home">
    <header class="page-heading">
      <h1>今日学习</h1>
    </header>

    <section v-if="error" class="panel empty-state">
      <p class="error" role="alert">{{ error }}</p><button class="btn btn-primary" type="button" @click="load">重试</button>
    </section>

    <section class="panel study-hero" :aria-busy="loading">
      <div class="study-total">
        <span v-if="loading" class="study-number-skeleton study-number-skeleton-total" aria-label="今日单词数量加载中" />
        <strong v-else>{{ total }}</strong>
        <span>今日单词</span>
      </div>
      <div class="study-metrics study-metrics-two">
        <template v-if="!snapshot">
          <div><span v-if="loading" class="study-number-skeleton" /><strong v-else>{{ plan?.dueCount ?? 0 }}</strong><span>复习</span></div>
          <div><span v-if="loading" class="study-number-skeleton" /><strong v-else>{{ plan?.newCount ?? 0 }}</strong><span>新词</span></div>
        </template>
        <template v-else>
          <div><span v-if="loading" class="study-number-skeleton" /><strong v-else>{{ remainingCards }}</strong><span>队列剩余</span></div>
          <div><span v-if="loading" class="study-number-skeleton" /><strong v-else>{{ sessionNewCount }}</strong><span>今日新词</span></div>
        </template>
      </div>
      <p v-if="!loading && recoveryText" class="recovery-note">{{ recoveryText }}</p>
    </section>

    <template v-if="hasLoaded && !error">

      <section v-if="visibleQueueChanges" class="panel queue-change-panel" aria-live="polite">
        <div><strong>词表有 {{ visibleQueueChanges }} 个变化</strong><p class="muted">只更新变化，不会打乱当前进度。</p></div>
        <div class="actions"><button class="btn btn-primary" :disabled="changeBusy" type="button" @click="applyChanges">更新今日队列</button><button class="btn btn-quiet" type="button" @click="dismissChanges">暂不</button></div>
      </section>
      <button v-else-if="dismissedQueueChanges" class="btn btn-quiet queue-change-restore" type="button" @click="queueChanges = queueChanges ? { ...queueChanges, dismissed: false } : null">查看词表变化</button>

      <section v-if="latestReading" class="panel reading-resume-panel">
        <div><p class="eyebrow">语境阅读</p><h2>{{ latestReading.title || '已生成的文章' }}</h2><p class="muted">{{ latestReading.dayKey }} · {{ latestReading.targetWordIds.length }} 个目标词</p></div>
        <div class="actions"><RouterLink v-if="canResumeLatestReading" class="btn btn-primary" :to="{ path: '/review/reading', query: { session: `daily:${latestReading.dayKey}`, batch: latestReading.batchIndex } }">继续阅读</RouterLink><RouterLink class="btn" to="/review/reading/history">文章记录</RouterLink></div>
      </section>

      <section v-if="!snapshot" class="panel">
        <div class="section-heading"><div><p class="eyebrow">来源</p><h2>今日词表贡献</h2></div><RouterLink class="btn" to="/lists">管理词表</RouterLink></div>
        <div v-if="plan?.listContributions?.length" class="contribution-list">
          <div v-for="item in plan.listContributions" :key="item.listId"><span>{{ item.name }}</span><strong>{{ item.count }} 词</strong></div>
        </div>
        <div v-else class="empty-state compact"><p>还没有参与学习的单词。</p><RouterLink class="btn btn-primary" to="/lookup">去查词并加入学习</RouterLink></div>
      </section>
    </template>

    <div class="study-primary-dock">
      <button class="btn btn-primary study-primary" :disabled="!hasLoaded" type="button" @click="start">{{ hasLoaded ? buttonLabel : '正在准备今日学习…' }}</button>
    </div>
  </main>
</template>
