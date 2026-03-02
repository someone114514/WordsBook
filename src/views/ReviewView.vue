<script setup lang="ts">
import dayjs from 'dayjs'
import { onActivated, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { StudyPlan, WordbookWithEntry } from '../types/models'
import {
  buildTodayPlanCached,
  getCachedStudyPlan,
  invalidateStudyPlanCache,
} from '../modules/review/reviewService'
import {
  listWordbookItems,
  removeWordFromWordbook,
  updateWordbookItem,
} from '../modules/wordbook/wordbookService'

const router = useRouter()

const loading = ref(false)
const studyPlan = ref<StudyPlan | null>(null)
const managerItems = ref<WordbookWithEntry[]>([])
const noteDrafts = reactive<Record<string, string>>({})
const message = ref('')
const savingWordId = ref<string | null>(null)
const deletingWordId = ref<string | null>(null)
const startingStudy = ref(false)

async function loadManagerItems() {
  managerItems.value = await listWordbookItems()
  for (const row of managerItems.value) {
    noteDrafts[row.item.wordId] = row.item.note
  }
}

async function loadPlan() {
  const cachedPlan = getCachedStudyPlan()
  if (cachedPlan) {
    studyPlan.value = cachedPlan
    loading.value = false
    void refreshPlanInBackground()
    return
  }

  loading.value = true
  try {
    studyPlan.value = await buildTodayPlanCached()
  } finally {
    loading.value = false
  }
}

async function refreshPlanInBackground() {
  const refreshed = await buildTodayPlanCached()
  studyPlan.value = refreshed
}

async function initialize() {
  await Promise.all([loadPlan(), loadManagerItems()])
}

onMounted(() => {
  void initialize()
})

onActivated(() => {
  void initialize()
})

async function startStudy() {
  if (!studyPlan.value || studyPlan.value.queueWordIds.length === 0) {
    message.value = '当前没有可背诵单词。'
    return
  }

  startingStudy.value = true
  try {
    await router.push('/review/session')
  } finally {
    startingStudy.value = false
  }
}

function isRowBusy(wordId: string): boolean {
  return savingWordId.value === wordId || deletingWordId.value === wordId
}

async function onSaveNote(wordId: string) {
  const note = noteDrafts[wordId] ?? ''
  savingWordId.value = wordId
  try {
    await updateWordbookItem(wordId, { note })
    await loadManagerItems()
    message.value = '备注已保存'
  } finally {
    savingWordId.value = null
  }
}

async function onDeleteWord(wordId: string) {
  const row = managerItems.value.find((item) => item.item.wordId === wordId)
  if (!window.confirm(`确认删除 ${row?.entry.headword ?? '该单词'} 吗？`)) {
    return
  }

  deletingWordId.value = wordId
  try {
    invalidateStudyPlanCache()
    await removeWordFromWordbook(wordId)
    await Promise.all([loadPlan(), loadManagerItems()])
    message.value = '已删除单词'
  } finally {
    deletingWordId.value = null
  }
}

function formatDateTime(iso?: string): string {
  if (!iso) {
    return '未安排'
  }

  return dayjs(iso).format('YYYY-MM-DD HH:mm')
}

function getSinceLastReviewDays(iso?: string): string {
  if (!iso) {
    return '-'
  }

  const days = dayjs().diff(iso, 'day', true)
  return `${Math.max(0, Math.round(days * 10) / 10)} 天`
}

function getScheduleOffsetLabel(nextReviewAt?: string): string {
  if (!nextReviewAt) {
    return '未安排'
  }

  const diffDays = dayjs().diff(nextReviewAt, 'day', true)
  const rounded = Math.round(Math.abs(diffDays) * 10) / 10
  if (diffDays >= 0) {
    return `已过期 ${rounded} 天`
  }

  return `提前 ${rounded} 天`
}
</script>

<template>
  <section class="panel">
    <Transition name="soft-fade-slide">
      <p v-if="message" class="success" role="status" aria-live="polite">{{ message }}</p>
    </Transition>

    <Transition name="soft-fade-slide">
      <div class="summary-card review-summary-card" v-if="studyPlan">
        <div class="review-stats-grid">
          <div class="review-stat-item">
            <span>到期复习</span>
            <strong>{{ studyPlan.dueCount }}</strong>
          </div>
          <div class="review-stat-item">
            <span>新词待学</span>
            <strong>{{ studyPlan.newCount }}</strong>
          </div>
          <div class="review-stat-item">
            <span>今日队列</span>
            <strong>{{ studyPlan.queueWordIds.length }}</strong>
          </div>
        </div>
      </div>
    </Transition>

    <Transition name="soft-fade-slide">
      <p v-if="loading" class="muted">正在生成今日计划...</p>
    </Transition>

    <article class="result-section review-manager-section">
      <h2>单词管理（可编辑/删除）</h2>
      <Transition name="soft-fade-slide">
        <div v-if="managerItems.length === 0" class="muted">暂无单词</div>
      </Transition>

      <TransitionGroup v-if="managerItems.length > 0" name="soft-list" tag="div" class="manager-list">
        <div v-for="row in managerItems" :key="row.item.wordId" class="manager-row review-manager-row">
          <div class="review-manager-head">
            <strong>{{ row.entry.headword }}</strong>
            <p class="muted">下次复习：{{ formatDateTime(row.reviewState?.nextReviewAt) }}</p>
            <p class="muted">距上次复习：{{ getSinceLastReviewDays(row.reviewState?.lastReviewedAt) }}</p>
            <p class="muted">当前偏差：{{ getScheduleOffsetLabel(row.reviewState?.nextReviewAt) }}</p>
          </div>

          <input
            v-model="noteDrafts[row.item.wordId]"
            class="inline-input"
            type="text"
            placeholder="备注"
            :disabled="isRowBusy(row.item.wordId)"
          />

          <div class="actions">
            <button class="btn" :disabled="isRowBusy(row.item.wordId)" @click="onSaveNote(row.item.wordId)">
              {{ savingWordId === row.item.wordId ? '保存中...' : '保存' }}
            </button>
            <button
              class="btn btn-danger"
              :disabled="isRowBusy(row.item.wordId)"
              @click="onDeleteWord(row.item.wordId)"
            >
              {{ deletingWordId === row.item.wordId ? '删除中...' : '删除' }}
            </button>
          </div>
        </div>
      </TransitionGroup>
    </article>

    <footer class="page-action-dock">
      <button
        class="btn btn-primary review-start-btn"
        :disabled="loading || startingStudy || !studyPlan || studyPlan.queueWordIds.length === 0"
        @click="startStudy"
      >
        {{
          loading
            ? '正在生成计划...'
            : startingStudy
              ? '进入中...'
              : studyPlan && studyPlan.queueWordIds.length > 0
                ? '开始沉浸背诵'
                : '今日暂无可背诵单词'
        }}
      </button>
    </footer>
  </section>
</template>
