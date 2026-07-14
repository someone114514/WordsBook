<script setup lang="ts">
import dayjs from 'dayjs'
import { computed, onActivated, ref } from 'vue'
import { useRouter } from 'vue-router'
import { db } from '../db/database'
import type { DailyLearningSession, ReadingSession, StudyPlan } from '../types/models'
import { buildTodayPlanCached, invalidateStudyPlanCache } from '../modules/review/reviewService'
import { listReadingHistory } from '../modules/reading/readingService'

const router = useRouter()
const loading = ref(true)
const error = ref('')
const plan = ref<StudyPlan | null>(null)
const session = ref<DailyLearningSession | null>(null)
const sessionStarted = ref(false)
const remainingCards = ref(0)
const readingHistory = ref<ReadingSession[]>([])
const latestReading = computed(() => readingHistory.value[0] ?? null)
const canResumeLatestReading = computed(() => latestReading.value?.dayKey === dayjs().format('YYYY-MM-DD'))

const total = computed(() => sessionStarted.value && session.value
  ? session.value.initialWordIds.length
  : plan.value?.queueWordIds.length ?? 0)
const buttonLabel = computed(() => {
  if (session.value?.status === 'completed') return '今日已完成'
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
    ;[plan.value, readingHistory.value] = await Promise.all([buildTodayPlanCached(), listReadingHistory()])
    if (session.value) {
      const [attemptCount, pendingCount] = await Promise.all([
        db.dailyQueueAttempts.where('sessionId').equals(session.value.sessionId).count(),
        db.dailyQueueItems.where('sessionId').equals(session.value.sessionId)
          .filter((item) => item.kind === 'card' && (item.status === 'pending' || item.status === 'active'))
          .count(),
      ])
      sessionStarted.value = attemptCount > 0
      remainingCards.value = pendingCount
    } else {
      sessionStarted.value = false
      remainingCards.value = 0
    }
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    loading.value = false
  }
}

async function start() {
  if (session.value?.status === 'completed') return
  await router.push('/review/session')
}

onActivated(() => {
  invalidateStudyPlanCache()
  void load()
})
</script>

<template>
  <main class="page-shell study-home">
    <header class="page-heading">
      <h1>今日学习</h1>
    </header>

    <section v-if="loading" class="panel empty-state" aria-live="polite">正在整理今日队列…</section>
    <section v-else-if="error" class="panel empty-state">
      <p class="error" role="alert">{{ error }}</p><button class="btn btn-primary" type="button" @click="load">重试</button>
    </section>
    <template v-else>
      <section class="panel study-hero">
        <div class="study-total"><strong>{{ total }}</strong><span>今日单词</span></div>
        <div class="study-metrics study-metrics-two">
          <template v-if="!sessionStarted">
            <div><strong>{{ plan?.dueCount ?? 0 }}</strong><span>复习</span></div>
            <div><strong>{{ plan?.newCount ?? 0 }}</strong><span>新词</span></div>
          </template>
          <template v-else>
            <div><strong>{{ remainingCards }}</strong><span>队列剩余</span></div>
            <div><strong>{{ session?.phase === 'article' ? '文章' : session?.status === 'completed' ? '完成' : '卡片' }}</strong><span>当前进度</span></div>
          </template>
        </div>
        <p v-if="recoveryText" class="recovery-note">{{ recoveryText }}</p>
        <button class="btn btn-primary study-primary" :disabled="session?.status === 'completed'" type="button" @click="start">{{ buttonLabel }}</button>
      </section>

      <section v-if="latestReading" class="panel reading-resume-panel">
        <div><p class="eyebrow">语境阅读</p><h2>{{ latestReading.title || '已生成的文章' }}</h2><p class="muted">{{ latestReading.dayKey }} · {{ latestReading.targetWordIds.length }} 个目标词</p></div>
        <div class="actions"><RouterLink v-if="canResumeLatestReading" class="btn btn-primary" :to="{ path: '/review/reading', query: { session: `daily:${latestReading.dayKey}`, batch: latestReading.batchIndex } }">继续阅读</RouterLink><RouterLink class="btn" to="/review/reading/history">文章记录</RouterLink></div>
      </section>

      <section class="panel">
        <div class="section-heading"><div><p class="eyebrow">来源</p><h2>今日词表贡献</h2></div><RouterLink class="btn" to="/lists">管理词表</RouterLink></div>
        <div v-if="plan?.listContributions?.length" class="contribution-list">
          <div v-for="item in plan.listContributions" :key="item.listId"><span>{{ item.name }}</span><strong>{{ item.count }} 词</strong></div>
        </div>
        <div v-else class="empty-state compact"><p>还没有参与学习的单词。</p><RouterLink class="btn btn-primary" to="/lookup">去查词并加入学习</RouterLink></div>
      </section>
    </template>
  </main>
</template>
