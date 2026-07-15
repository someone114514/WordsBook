<script setup lang="ts">
import { computed, onActivated, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { addWordToStudyList, deleteStudyList, listStudyLists, listStudyListWords, removeWordFromStudyList, setStudyListWordsLearningEnabled, updateStudyList } from '../modules/wordbook/studyListService'
import { importWordList, previewWordList, WORD_LIST_JSON_EXAMPLE } from '../modules/wordbook/wordListImportService'

const route = useRoute(); const router = useRouter()
const listId = computed(() => String(route.params.listId))
const tab = ref<'words'|'import'|'settings'>('words')
const lists = ref<Awaited<ReturnType<typeof listStudyLists>>>([])
const words = ref<Awaited<ReturnType<typeof listStudyListWords>>>([])
const query = ref(''); const selected = ref<string[]>([]); const targetListId = ref('')
const importText = ref(''); const importStep = ref<1|2|3>(1); const preview = ref<Awaited<ReturnType<typeof previewWordList>> | null>(null); const report = ref<Awaited<ReturnType<typeof importWordList>> | null>(null)
const busy = ref(false); const message = ref(''); const importError = ref('')
const current = computed(() => lists.value.find((list) => list.listId === listId.value))
const filtered = computed(() => words.value.filter((row) => !query.value.trim() || row.entry?.headwordLower.includes(query.value.trim().toLowerCase())))
const draftName = ref(''); const draftDescription = ref('')

async function load() {
  lists.value = await listStudyLists(); words.value = await listStudyListWords(listId.value)
  draftName.value = current.value?.name ?? ''; draftDescription.value = current.value?.description ?? ''
}
async function onFile(event: Event) { const file = (event.target as HTMLInputElement).files?.[0]; if (file) importText.value = await file.text() }
async function makePreview() { busy.value = true; importError.value = ''; try { preview.value = await previewWordList(importText.value); importStep.value = 2 } catch (reason) { importError.value = reason instanceof Error ? reason.message : String(reason) } finally { busy.value = false } }
async function runImport() { busy.value = true; importError.value = ''; try { report.value = await importWordList(listId.value, importText.value); importStep.value = 3; await load() } catch (reason) { importError.value = reason instanceof Error ? reason.message : String(reason) } finally { busy.value = false } }
function useJsonExample() { importText.value = WORD_LIST_JSON_EXAMPLE; importError.value = '' }
async function removeSelected() { await Promise.all(selected.value.map((id) => removeWordFromStudyList(listId.value, id))); selected.value = []; await load() }
async function moveSelected(copy = false) { if (!targetListId.value) return; await Promise.all(selected.value.map((id) => addWordToStudyList(targetListId.value, id))); if (!copy) await removeSelected(); else { selected.value = []; await load() } }
async function setSelectedLearning(enabled: boolean) { const count = await setStudyListWordsLearningEnabled(listId.value, selected.value, enabled); message.value = enabled ? `已将 ${count} 个词加入学习` : `已暂停 ${count} 个词`; selected.value = []; await load() }
async function saveSettings() { if (!current.value) return; await updateStudyList(listId.value, { name: draftName.value, description: draftDescription.value, studyEnabled: current.value.studyEnabled }); message.value = '词表设置已保存'; await load() }
async function toggleStudy() { if (!current.value) return; await updateStudyList(listId.value, { studyEnabled: current.value.studyEnabled ? 0 : 1 }); await load() }
async function removeList() { if (!current.value || !confirm(`删除“${current.value.name}”？单词和复习历史会保留。`)) return; await deleteStudyList(listId.value); await router.replace('/lists') }
onActivated(() => void load())
</script>

<template>
  <main v-if="current" class="page-shell list-detail">
    <header class="detail-header"><RouterLink class="btn" to="/lists">返回词表</RouterLink><div><h1>{{ current.name }}</h1><p>{{ current.wordCount }} 个单词 · 已激活 {{ current.activeWordCount }} 个 · {{ current.studyEnabled ? '词表参与每日学习' : '词表已暂停' }}</p></div></header>
    <nav class="detail-tabs" aria-label="词表详情"><button :class="{ active: tab === 'words' }" @click="tab='words'">单词</button><button :class="{ active: tab === 'import' }" @click="tab='import'">导入</button><button :class="{ active: tab === 'settings' }" @click="tab='settings'">设置</button></nav>
    <p v-if="message" class="success" role="status">{{ message }}</p>
    <section v-if="tab === 'words'" class="panel">
      <div class="section-heading"><input v-model="query" class="search-input" placeholder="搜索当前词表" /><label><input type="checkbox" :checked="selected.length === filtered.length && filtered.length > 0" @change="selected = ($event.target as HTMLInputElement).checked ? filtered.map(row => row.item.wordId) : []" /> 全选</label></div>
      <div v-if="filtered.length" class="word-list-clean"><label v-for="row in filtered" :key="row.item.wordId"><input v-model="selected" type="checkbox" :value="row.item.wordId"/><span><strong>{{ row.entry?.headword ?? row.item.entryId }}</strong><small>{{ row.membership.learningEnabled === 0 ? '待学习' : '已激活' }} · {{ row.item.note || '无备注' }}</small></span></label></div>
      <div v-else class="empty-state compact"><h3>词表还是空的</h3><p>可以批量导入，也可以从查词页一键加入。</p><button class="btn btn-primary" @click="tab='import'">导入词表</button><RouterLink class="btn" to="/lookup">去查词</RouterLink></div>
      <div v-if="selected.length" class="mobile-batch-bar"><button class="btn btn-primary" @click="setSelectedLearning(true)">加入学习</button><button class="btn" @click="setSelectedLearning(false)">暂停学习</button><select v-model="targetListId" class="inline-input"><option value="">目标词表</option><option v-for="list in lists.filter(item => item.listId !== listId)" :key="list.listId" :value="list.listId">{{ list.name }}</option></select><button class="btn" :disabled="!targetListId" @click="moveSelected(true)">复制</button><button class="btn" :disabled="!targetListId" @click="moveSelected()">移动</button><button class="btn btn-danger" @click="removeSelected">移出</button></div>
    </section>
    <section v-else-if="tab === 'import'" class="panel import-flow">
      <div class="stepper"><span :class="{active: importStep >= 1}">1 来源</span><span :class="{active: importStep >= 2}">2 预览</span><span :class="{active: importStep >= 3}">3 完成</span></div>
      <template v-if="importStep === 1"><p>粘贴内容，或选择 JSON / TXT / CSV / TSV。字段支持 word、meaning、note、tags。</p><input type="file" accept=".json,.txt,.csv,.tsv,application/json,text/plain,text/csv" @change="onFile"/><textarea v-model="importText" class="notes-area import-area" rows="10" placeholder="粘贴 JSON，或 word,meaning,note,tags"></textarea><details class="import-example"><summary>查看 JSON 范例</summary><pre>{{ WORD_LIST_JSON_EXAMPLE }}</pre><button class="btn" type="button" @click="useJsonExample">使用此范例</button></details><p v-if="importError" class="error" role="alert">{{ importError }}</p><button class="btn btn-primary" :disabled="busy || !importText.trim()" @click="makePreview">预览导入</button></template>
      <template v-else-if="importStep === 2 && preview"><div class="preview-stats"><div><strong>{{ preview.rows.length }}</strong><span>总行数</span></div><div><strong>{{ preview.matched }}</strong><span>词典匹配</span></div><div><strong>{{ preview.pending }}</strong><span>待补全</span></div><div><strong>{{ preview.duplicates }}</strong><span>重复</span></div><div><strong>{{ preview.invalid }}</strong><span>无效</span></div></div><p v-if="importError" class="error" role="alert">{{ importError }}</p><button class="btn" @click="importStep=1">返回修改</button><button class="btn btn-primary" :disabled="busy" @click="runImport">确认导入</button></template>
      <template v-else-if="report"><h2>导入完成</h2><p>匹配 {{ report.matched }}，新建 {{ report.created }}，待补全 {{ report.pending }}，重复 {{ report.duplicates }}，无效 {{ report.invalid }}。导入词已进入待学习，不会自动加入每日队列。</p><button class="btn btn-primary" @click="tab='words'; importStep=1; importText=''">查看单词</button></template>
    </section>
    <section v-else class="panel settings-form"><label>名称<input v-model="draftName" class="inline-input"/></label><label>说明<textarea v-model="draftDescription" class="notes-area" rows="3"/></label><label class="setting-switch"><span><strong>参与每日学习</strong><small>开启后与其他词表混合去重</small></span><input type="checkbox" :checked="Boolean(current.studyEnabled)" @change="toggleStudy"/></label><button class="btn btn-primary" @click="saveSettings">保存设置</button><button v-if="!current.systemType" class="btn btn-danger" @click="removeList">删除词表</button></section>
  </main>
</template>
