<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { StudyPlan, WordbookWithEntry } from '../types/models'
import { buildTodayPlan } from '../modules/review/reviewService'
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

async function loadManagerItems() {
  managerItems.value = await listWordbookItems()
  for (const row of managerItems.value) {
    noteDrafts[row.item.wordId] = row.item.note
  }
}

async function loadPlan() {
  loading.value = true
  try {
    studyPlan.value = await buildTodayPlan()
  } finally {
    loading.value = false
  }
}

async function initialize() {
  await Promise.all([loadPlan(), loadManagerItems()])
}

onMounted(() => {
  void initialize()
})

async function startStudy() {
  if (!studyPlan.value || studyPlan.value.queueWordIds.length === 0) {
    message.value = '当前没有可背诵单词。'
    return
  }

  await router.push('/review/session')
}

async function onSaveNote(wordId: string) {
  const note = noteDrafts[wordId] ?? ''
  await updateWordbookItem(wordId, { note })
  await loadManagerItems()
  message.value = '备注已保存'
}

async function onDeleteWord(wordId: string) {
  await removeWordFromWordbook(wordId)
  await Promise.all([loadPlan(), loadManagerItems()])
  message.value = '已删除单词'
}
</script>

<template>
  <section class="panel">
    <p v-if="message" class="success">{{ message }}</p>

    <div class="summary-card" v-if="studyPlan">
      <p><strong>到期复习：</strong>{{ studyPlan.dueCount }}</p>
      <p><strong>新词待学：</strong>{{ studyPlan.newCount }}</p>
      <p><strong>今日队列：</strong>{{ studyPlan.queueWordIds.length }}</p>
      <button class="btn btn-primary" :disabled="loading" @click="startStudy">开始沉浸背诵</button>
    </div>

    <p v-if="loading" class="muted">正在生成今日计划...</p>

    <article class="result-section">
      <h2>单词管理（可编辑/删除）</h2>
      <div v-if="managerItems.length === 0" class="muted">暂无单词</div>

      <div v-for="row in managerItems" :key="row.item.wordId" class="manager-row">
        <div>
          <strong>{{ row.entry.headword }}</strong>
          <p class="muted">下次复习：{{ row.reviewState?.nextReviewAt || '未安排' }}</p>
        </div>

        <input
          v-model="noteDrafts[row.item.wordId]"
          class="inline-input"
          type="text"
          placeholder="备注"
        />

        <div class="actions">
          <button class="btn" @click="onSaveNote(row.item.wordId)">保存</button>
          <button class="btn btn-danger" @click="onDeleteWord(row.item.wordId)">删除</button>
        </div>
      </div>
    </article>
  </section>
</template>
