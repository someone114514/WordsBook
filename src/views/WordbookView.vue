<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import type { WordbookWithEntry } from '../types/models'
import {
  listWordbookItems,
  removeWordFromWordbook,
  updateWordbookItem,
} from '../modules/wordbook/wordbookService'
import { parseJsonArray } from '../utils/json'

const loading = ref(false)
const rows = ref<WordbookWithEntry[]>([])
const query = ref('')
const noteDrafts = reactive<Record<string, string>>({})
const tagsDrafts = reactive<Record<string, string>>({})
const message = ref('')

const filteredRows = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  if (!keyword) {
    return rows.value
  }

  return rows.value.filter((row) => row.entry.headwordLower.includes(keyword))
})

async function loadRows() {
  loading.value = true
  try {
    rows.value = await listWordbookItems()
    for (const row of rows.value) {
      noteDrafts[row.item.wordId] = row.item.note
      tagsDrafts[row.item.wordId] = row.item.tags.join(', ')
    }
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadRows()
})

async function onSave(row: WordbookWithEntry) {
  const tags = parseJsonArray(JSON.stringify((tagsDrafts[row.item.wordId] ?? '').split(',')))
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)

  await updateWordbookItem(row.item.wordId, {
    note: noteDrafts[row.item.wordId] ?? '',
    tags,
  })

  message.value = `已更新 ${row.entry.headword}`
  await loadRows()
}

async function onDelete(wordId: string) {
  await removeWordFromWordbook(wordId)
  message.value = '已删除单词'
  await loadRows()
}
</script>

<template>
  <section class="panel">
    <p v-if="message" class="success">{{ message }}</p>

    <input v-model="query" class="search-input" type="text" placeholder="搜索单词本" />

    <p v-if="loading" class="muted">加载中...</p>
    <p v-else-if="filteredRows.length === 0" class="muted">暂无数据</p>

    <div v-for="row in filteredRows" :key="row.item.wordId" class="entry-card">
      <div class="entry-header">
        <h3>{{ row.entry.headword }}</h3>
        <span class="chip">周期 {{ row.reviewState?.cycle ?? 0 }}</span>
      </div>

      <ul>
        <li v-for="sense in parseJsonArray(row.entry.sensesJson)" :key="sense">{{ sense }}</li>
      </ul>

      <input
        v-model="noteDrafts[row.item.wordId]"
        class="inline-input"
        type="text"
        placeholder="备注"
      />
      <input
        v-model="tagsDrafts[row.item.wordId]"
        class="inline-input"
        type="text"
        placeholder="标签，逗号分隔"
      />

      <div class="actions">
        <button class="btn" @click="onSave(row)">保存</button>
        <button class="btn btn-danger" @click="onDelete(row.item.wordId)">删除</button>
      </div>
    </div>
  </section>
</template>
