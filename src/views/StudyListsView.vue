<script setup lang="ts">
import { computed, onActivated, ref } from 'vue'
import { Plus } from 'lucide-vue-next'
import { createStudyList, listStudyLists } from '../modules/wordbook/studyListService'

type ListRow = Awaited<ReturnType<typeof listStudyLists>>[number]
const lists = ref<ListRow[]>([])
const name = ref('')
const busy = ref(false)
const error = ref('')
const message = ref('')
const learningLists = computed(() => lists.value.filter((list) => list.systemType !== 'lookup'))
const savedList = computed(() => lists.value.find((list) => list.systemType === 'lookup' && list.wordCount > 0))

async function load() {
  error.value = ''
  try { lists.value = await listStudyLists() }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
}

async function create() {
  const normalized = name.value.trim()
  if (!normalized || busy.value) return
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    const list = await createStudyList(normalized)
    name.value = ''
    message.value = `已创建「${list.name}」`
    await load()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally { busy.value = false }
}

onActivated(() => void load())
</script>

<template>
  <main class="page-shell lists-overview">
    <section class="panel create-list-panel">
      <h2>新建词表</h2>
      <form class="inline-create" @submit.prevent="create">
        <label class="sr-only" for="new-list-name">词表名称</label>
        <input id="new-list-name" v-model="name" class="inline-input" autocomplete="off" placeholder="输入词表名称" />
        <button class="btn btn-primary" :disabled="busy || !name.trim()" type="submit"><Plus :size="19" aria-hidden="true" />{{ busy ? '创建中…' : '创建' }}</button>
      </form>
      <p v-if="error" class="error" role="alert">创建失败：{{ error }}</p>
      <p v-if="message" class="success" role="status">{{ message }}</p>
    </section>

    <section class="panel">
      <div class="section-heading"><div><h2>学习词表</h2><p class="muted">{{ learningLists.filter(item => item.studyEnabled).length }} 个参与今日队列</p></div></div>
      <div v-if="learningLists.length" class="list-card-grid">
        <article v-for="list in learningLists" :key="list.listId" class="list-overview-card">
          <header class="list-card-heading">
            <strong>{{ list.name }}</strong>
            <span :class="['list-status-chip', { active: list.studyEnabled }]">{{ list.studyEnabled ? '参与学习' : '已暂停' }}</span>
          </header>
          <div class="list-count"><strong>{{ list.wordCount }}</strong><span>个单词</span></div>
          <p v-if="list.description" class="list-card-description">{{ list.description }}</p>
          <RouterLink class="btn" :to="`/lists/${encodeURIComponent(list.listId)}`">管理词表</RouterLink>
        </article>
      </div>
      <div v-else class="empty-state compact"><p>输入名称创建词表，或从查词页加入单词。</p><RouterLink class="btn" to="/lookup">去查词</RouterLink></div>
    </section>
    <section v-if="savedList" class="panel"><div class="section-heading"><div><h2>仅保存</h2><p class="muted">不参与每日学习</p></div><RouterLink class="btn" :to="`/lists/${encodeURIComponent(savedList.listId)}`">查看 {{ savedList.wordCount }} 词</RouterLink></div></section>
  </main>
</template>
