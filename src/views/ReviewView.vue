<script setup lang="ts">
import dayjs from 'dayjs'
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { StudyPlan, WordbookWithEntry } from '../types/models'
import {
  buildTodayPlanCached,
  getCachedStudyPlan,
  invalidateStudyPlanCache,
} from '../modules/review/reviewService'
import {
  WORDBOOK_UPDATED_EVENT,
  listWordbookItems,
  removeWordFromWordbook,
  updateWordbookItem,
} from '../modules/wordbook/wordbookService'

const router = useRouter()

const loading = ref(false)
const managerLoading = ref(false)
const studyPlan = ref<StudyPlan | null>(null)
const managerItems = ref<WordbookWithEntry[]>([])
const managerHasLoaded = ref(false)
const noteDrafts = reactive<Record<string, string>>({})
const message = ref('')
const savingWordId = ref<string | null>(null)
const deletingWordId = ref<string | null>(null)
const startingStudy = ref(false)
const hasLoaded = ref(false)
const pendingRefresh = ref(false)
const lastRefreshAt = ref(0)
const managerQuery = ref('')
const managerVisibleLimit = ref(40)
const managerMotionThreshold = 24
const managerPageSize = 40
let activateRefreshTimer: number | null = null
let managerLoadTimer: number | null = null
let managerLoadToken = 0

async function loadManagerItems() {
  const token = ++managerLoadToken
  managerLoading.value = true
  try {
    const rows = await listWordbookItems()
    if (token !== managerLoadToken) {
      return
    }

    managerItems.value = rows
    managerHasLoaded.value = true
    for (const row of rows) {
      noteDrafts[row.item.wordId] = row.item.note
    }
  } finally {
    if (token === managerLoadToken) {
      managerLoading.value = false
    }
  }
}

function clearManagerTimer() {
  if (managerLoadTimer !== null) {
    window.clearTimeout(managerLoadTimer)
    managerLoadTimer = null
  }
}

function scheduleManagerLoad(delayMs = 0) {
  clearManagerTimer()
  managerLoadTimer = window.setTimeout(() => {
    managerLoadTimer = null
    void loadManagerItems()
  }, delayMs)
}

function cancelManagerLoad() {
  managerLoadToken += 1
  managerLoading.value = false
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
  await loadPlan()
  hasLoaded.value = true
  pendingRefresh.value = false
  lastRefreshAt.value = Date.now()
  scheduleManagerLoad(managerItems.value.length > 0 ? 0 : 90)
}

function clearActivateTimer() {
  if (activateRefreshTimer !== null) {
    window.clearTimeout(activateRefreshTimer)
    activateRefreshTimer = null
  }
}

function scheduleActivateRefresh() {
  clearActivateTimer()
  const refreshDelayMs = 170
  activateRefreshTimer = window.setTimeout(() => {
    activateRefreshTimer = null
    void initialize()
  }, refreshDelayMs)
}

onMounted(() => {
  void initialize()
  window.addEventListener(WORDBOOK_UPDATED_EVENT, onWordbookUpdated)
})

onActivated(() => {
  const refreshIntervalMs = 20 * 1000
  const shouldRefresh = pendingRefresh.value || Date.now() - lastRefreshAt.value > refreshIntervalMs
  if (!hasLoaded.value || shouldRefresh || !managerHasLoaded.value) {
    scheduleActivateRefresh()
  }
})

onDeactivated(() => {
  clearActivateTimer()
  clearManagerTimer()
  cancelManagerLoad()
})

onUnmounted(() => {
  clearActivateTimer()
  clearManagerTimer()
  cancelManagerLoad()
  window.removeEventListener(WORDBOOK_UPDATED_EVENT, onWordbookUpdated)
})

function onWordbookUpdated() {
  pendingRefresh.value = true
  if (hasLoaded.value) {
    scheduleActivateRefresh()
  }
}

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

const managerRows = computed(() =>
  managerItems.value.map((row) => ({
    ...row,
    nextReviewText: formatDateTime(row.reviewState?.nextReviewAt),
    sinceLastReviewText: getSinceLastReviewDays(row.reviewState?.lastReviewedAt),
    scheduleOffsetText: getScheduleOffsetLabel(row.reviewState?.nextReviewAt),
  })),
)

const filteredManagerRows = computed(() => {
  const keyword = managerQuery.value.trim().toLowerCase()
  if (!keyword) {
    return managerRows.value
  }

  return managerRows.value.filter((row) => {
    const haystack = [
      row.entry.headword,
      row.entry.headwordLower,
      row.entry.phonetic ?? '',
      row.item.note,
      row.item.tags.join(' '),
    ]
      .join(' ')
      .toLowerCase()
    return haystack.includes(keyword)
  })
})

const visibleManagerRows = computed(() => filteredManagerRows.value.slice(0, managerVisibleLimit.value))
const hiddenManagerRowCount = computed(() =>
  Math.max(filteredManagerRows.value.length - visibleManagerRows.value.length, 0),
)
const shouldAnimateManagerList = computed(() => visibleManagerRows.value.length <= managerMotionThreshold)

function showMoreManagerRows(): void {
  managerVisibleLimit.value += managerPageSize
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
      <div class="manager-toolbar">
        <input
          v-model="managerQuery"
          class="search-input manager-search-input"
          type="search"
          placeholder="搜索要删除或编辑的单词"
          @input="managerVisibleLimit = managerPageSize"
        />
        <p class="muted">
          显示 {{ visibleManagerRows.length }} / {{ filteredManagerRows.length }}
        </p>
      </div>
      <Transition name="soft-fade-slide">
        <div v-if="managerLoading && !managerHasLoaded" class="muted">
          正在加载单词管理...
        </div>
        <div v-else-if="managerHasLoaded && filteredManagerRows.length === 0" class="muted">
          {{ managerItems.length === 0 ? '暂无单词' : '没有匹配的单词' }}
        </div>
      </Transition>

      <TransitionGroup
        v-if="visibleManagerRows.length > 0"
        :css="shouldAnimateManagerList"
        name="soft-list"
        tag="div"
        class="manager-list"
      >
        <div v-for="row in visibleManagerRows" :key="row.item.wordId" class="manager-row review-manager-row">
          <div class="review-manager-head">
            <strong>{{ row.entry.headword }}</strong>
            <p class="muted">下次复习：{{ row.nextReviewText }}</p>
            <p class="muted">距上次复习：{{ row.sinceLastReviewText }}</p>
            <p class="muted">当前偏差：{{ row.scheduleOffsetText }}</p>
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

      <button
        v-if="hiddenManagerRowCount > 0"
        type="button"
        class="btn btn-quiet manager-show-more"
        @click="showMoreManagerRows"
      >
        显示更多（还有 {{ hiddenManagerRowCount }} 个）
      </button>
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
