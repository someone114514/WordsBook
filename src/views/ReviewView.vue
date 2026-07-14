<script setup lang="ts">
import dayjs from 'dayjs'
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { db } from '../db/database'
import type { DailyLearningSession, StudyPlan } from '../types/models'
import { buildTodayPlanCached, invalidateStudyPlanCache } from '../modules/review/reviewService'

const router = useRouter()
const loading = ref(true)
const error = ref('')
const plan = ref<StudyPlan | null>(null)
const session = ref<DailyLearningSession | null>(null)

const total = computed(() => session.value?.initialWordIds.length ?? plan.value?.queueWordIds.length ?? 0)
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
    plan.value = await buildTodayPlanCached()
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

onMounted(() => {
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
        <div class="study-metrics">
          <div><strong>{{ plan?.dueCount ?? 0 }}</strong><span>到期复习</span></div>
          <div><strong>{{ plan?.newCount ?? 0 }}</strong><span>新词</span></div>
          <div><strong>{{ session?.phase === 'article' ? '文章' : session?.status === 'completed' ? '完成' : '卡片' }}</strong><span>当前阶段</span></div>
        </div>
        <p v-if="recoveryText" class="recovery-note">{{ recoveryText }}</p>
        <button class="btn btn-primary study-primary" :disabled="session?.status === 'completed'" type="button" @click="start">{{ buttonLabel }}</button>
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
