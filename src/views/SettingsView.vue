<script setup lang="ts">
import { computed, onActivated, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useDictionaryStore } from '../modules/dictionary/dictionaryStore'
import { exportUserData, importUserData } from '../modules/settings/backupService'
import { useSettingsStore } from '../modules/settings/settingsStore'
import {
  getCloudAuthState,
  signInCloud,
  signOutCloud,
  type CloudAuthState,
} from '../modules/sync/cloudAuthService'
import { getLastSuccessfulSyncAt, previewCloudSync, runCloudSync } from '../modules/sync/syncEngine'
import { getSupabaseClient, isSupabaseConfigured } from '../modules/sync/supabaseClient'
import { SupabaseCloudSyncRemote } from '../modules/sync/supabaseRemote'
import { deleteDeepseekSecret, syncDeepseekSecret, unloadDeepseekSecret, uploadDeepseekSecret } from '../modules/sync/cloudSecretService'
import type { CloudSyncMode, SyncPreview, SyncResult } from '../modules/sync/syncTypes'
import { getWordbookStats } from '../modules/wordbook/wordbookService'

const settingsStore = useSettingsStore()
const dictionaryStore = useDictionaryStore()

const { settings } = storeToRefs(settingsStore)
const { installedMeta, installing, progress, lastError, fullCacheProgress } = storeToRefs(dictionaryStore)
const fullCachePaused = ref(false)

const message = ref('')
const wordbookStats = ref({ total: 0, active: 0 })
const cloudAuth = ref<CloudAuthState>({
  configured: isSupabaseConfigured(),
  signedIn: false,
  email: '',
  userId: '',
  needsLogin: isSupabaseConfigured(),
})
const cloudEmail = ref('')
const cloudPassword = ref('')
const cloudBusy = ref(false)
const cloudMessage = ref('')
const cloudPreview = ref<SyncPreview | null>(null)
const cloudLastResult = ref<SyncResult | null>(null)
const cloudLastSyncAt = ref<string | null>(null)

const SETTINGS_REFRESH_TTL_MS = 15 * 1000
let settingsRefreshPromise: Promise<void> | null = null
let lastSettingsRefreshAt = 0

const cloudStatusText = computed(() => {
  if (!cloudAuth.value.configured) {
    return '未配置 Supabase，本机离线模式'
  }

  if (cloudAuth.value.signedIn) {
    return `已连接：${cloudAuth.value.email || cloudAuth.value.userId}`
  }

  return '未登录，访客只使用本地数据'
})

const installProgressText = computed(() => {
  if (!progress.value) {
    return ''
  }

  return `${progress.value.message} (${Math.floor(progress.value.ratio * 100)}%)`
})

const installProgressDetails = computed(() => {
  const stats = progress.value?.stats
  if (!stats) {
    return ''
  }

  const parts: string[] = []
  if (stats.currentDictionary) {
    parts.push(`词典：${stats.currentDictionary}`)
  }
  if (stats.currentShard) {
    const shardText =
      stats.shardIndex && stats.shardTotal
        ? `分片 ${stats.shardIndex}/${stats.shardTotal}`
        : '分片'
    parts.push(`${shardText}：${stats.currentShard}`)
  }
  if (typeof stats.entries === 'number') {
    parts.push(`已写词条 ${stats.entries.toLocaleString()}`)
  }
  if (typeof stats.indices === 'number') {
    parts.push(`已写索引 ${stats.indices.toLocaleString()}`)
  }
  if (typeof stats.batchesWritten === 'number') {
    parts.push(`批次 ${stats.batchesWritten}`)
  }
  if (typeof stats.elapsedMs === 'number') {
    parts.push(`耗时 ${(stats.elapsedMs / 1000).toFixed(1)}s`)
  }

  return parts.join(' | ')
})

function initializeSettingsView(options: { force?: boolean } = {}): Promise<void> {
  const now = Date.now()
  if (settingsRefreshPromise) {
    return settingsRefreshPromise
  }

  if (!options.force && lastSettingsRefreshAt > 0 && now - lastSettingsRefreshAt < SETTINGS_REFRESH_TTL_MS) {
    return Promise.resolve()
  }

  lastSettingsRefreshAt = now
  settingsRefreshPromise = Promise.allSettled([
    settingsStore.initialize(),
    dictionaryStore.refreshInstalledMeta(),
    refreshStats(),
    refreshCloudState(),
  ])
    .then(() => undefined)
    .finally(() => {
      settingsRefreshPromise = null
    })

  return settingsRefreshPromise
}

onMounted(() => {
  void initializeSettingsView({ force: true })
})

onActivated(() => {
  void initializeSettingsView()
})

async function refreshStats() {
  wordbookStats.value = await getWordbookStats()
}

async function onUpdateBoolean(key: 'autoPronunciation', event: Event) {
  const target = event.target as HTMLInputElement
  await settingsStore.update({ [key]: target.checked })
}

async function onUpdateNumber(
  key: 'dailyNewLimit' | 'dailyReviewLimit' | 'speechRate',
  event: Event,
): Promise<void> {
  const target = event.target as HTMLInputElement
  const value = Number(target.value)
  if (!Number.isFinite(value)) {
    return
  }

  await settingsStore.update({ [key]: value })
}

async function onUpdateEngine(event: Event): Promise<void> {
  const target = event.target as HTMLSelectElement
  await settingsStore.update({
    ttsEngine: target.value as 'auto' | 'browser' | 'youdao' | 'google' | 'dictionaryapi',
  })
}

async function onUpdateArticleLevel(event: Event): Promise<void> {
  const target = event.target as HTMLSelectElement
  await settingsStore.update({ articleLevel: target.value as 'A2' | 'B1' | 'B2' | 'C1' })
}

async function onUpdateString(
  key: 'deepseekApiKey' | 'deepseekBaseUrl' | 'deepseekModel',
  event: Event,
): Promise<void> {
  const target = event.target as HTMLInputElement
  await settingsStore.update({ [key]: target.value.trim() })
  if (key === 'deepseekApiKey' && settings.value.syncDeepseekApiKey && cloudAuth.value.signedIn) {
    if (target.value.trim()) await uploadDeepseekSecret(target.value.trim())
    else await deleteDeepseekSecret()
    cloudMessage.value = target.value.trim() ? 'DeepSeek Key 已同步到当前账号' : '本地与云端 Key 已删除'
  }
}

async function onToggleKeySync(event: Event) {
  const enabled = (event.target as HTMLInputElement).checked
  await settingsStore.update({ syncDeepseekApiKey: enabled })
  if (!enabled) { cloudMessage.value = '已关闭 Key 云同步；云端已有 Key 不会自动删除'; return }
  if (!cloudAuth.value.signedIn) { cloudMessage.value = '请先登录云同步账号，再开启 Key 同步'; await settingsStore.update({ syncDeepseekApiKey: false }); return }
  const value = await syncDeepseekSecret()
  await settingsStore.initialize()
  cloudMessage.value = value ? 'DeepSeek Key 已与当前账号同步' : '已开启；填写 Key 后会同步到当前账号'
}

async function onInstallDictionary() {
  await dictionaryStore.installDefaultDictionary()
}

function toggleFullDictionaryDownload() {
  fullCachePaused.value = !fullCachePaused.value
  if (fullCachePaused.value) dictionaryStore.pauseFullDictionaryDownload()
  else dictionaryStore.resumeFullDictionaryDownload()
}

async function onExport() {
  const blob = await exportUserData()
  downloadBlob(blob, `wordsbook-backup-${new Date().toISOString().slice(0, 10)}.json`)
  message.value = '备份文件已导出'
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

async function onImport(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]

  if (!file) {
    return
  }

  const report = await importUserData(file)
  await Promise.all([settingsStore.initialize(), refreshStats()])

  message.value = `导入完成：${report.importedWordbook} 个单词，${report.importedReviewLogs} 条复习日志，${report.importedAiOverrides} 条 AI 释义`
  target.value = ''
}

async function refreshCloudState() {
  try {
    cloudAuth.value = await getCloudAuthState()
    cloudLastSyncAt.value = await getLastSuccessfulSyncAt()
  } catch (error) {
    cloudAuth.value = {
      configured: isSupabaseConfigured(),
      signedIn: false,
      email: '',
      userId: '',
      needsLogin: true,
    }
    cloudMessage.value = error instanceof Error ? error.message : String(error)
  }
}

function getCloudRemote(): SupabaseCloudSyncRemote {
  const client = getSupabaseClient()
  if (!client) {
    throw new Error('未配置 Supabase URL 或 Publishable Key')
  }

  return new SupabaseCloudSyncRemote(client)
}

async function onCloudSignIn() {
  cloudBusy.value = true
  cloudMessage.value = ''
  try {
    cloudAuth.value = await signInCloud(cloudEmail.value.trim(), cloudPassword.value)
    cloudPassword.value = ''
    if (settings.value.syncDeepseekApiKey) {
      await syncDeepseekSecret()
      await settingsStore.initialize()
    }
    cloudMessage.value = '云同步已登录'
  } catch (error) {
    cloudMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    cloudBusy.value = false
  }
}

async function onCloudSignOut() {
  cloudBusy.value = true
  cloudMessage.value = ''
  try {
    const userId = cloudAuth.value.userId
    if (settings.value.syncDeepseekApiKey && userId) await unloadDeepseekSecret(userId)
    await signOutCloud()
    await settingsStore.initialize()
    await refreshCloudState()
    cloudPreview.value = null
    cloudLastResult.value = null
    cloudMessage.value = '已退出云同步，本地数据不受影响'
  } finally {
    cloudBusy.value = false
  }
}

async function onPreviewCloudSync(mode: CloudSyncMode) {
  cloudBusy.value = true
  cloudMessage.value = ''
  try {
    cloudPreview.value = await previewCloudSync(getCloudRemote(), mode)
    cloudMessage.value = '同步预览已生成'
  } catch (error) {
    cloudMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    cloudBusy.value = false
  }
}

async function onRunCloudSync(mode: CloudSyncMode) {
  cloudBusy.value = true
  cloudMessage.value = ''
  try {
    if (mode === 'upload') {
      const backup = await exportUserData()
      downloadBlob(backup, `wordsbook-before-cloud-upload-${new Date().toISOString().slice(0, 10)}.json`)
    }

    const result = await runCloudSync(getCloudRemote(), mode)
    cloudLastResult.value = result
    cloudPreview.value = result
    cloudLastSyncAt.value = result.completedAt
    await Promise.all([settingsStore.initialize(), refreshStats()])
    if (settings.value.syncDeepseekApiKey) {
      await syncDeepseekSecret()
      await settingsStore.initialize()
    }
    cloudMessage.value = `同步完成：上传 ${result.pushed}，下载 ${result.pulled}，删除 ${result.deleted}`
  } catch (error) {
    cloudMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    cloudBusy.value = false
  }
}
</script>

<template>
  <section class="panel">
    <Transition name="soft-fade-slide">
      <p v-if="message" class="success">{{ message }}</p>
    </Transition>

    <article class="result-section">
      <h2>词典</h2>
      <p v-if="installedMeta" class="muted">
        当前版本 {{ installedMeta.version }}，词条 {{ installedMeta.entryCount }}
      </p>
      <p v-else class="muted">尚未安装词典</p>
      <button class="btn btn-primary" :disabled="installing" @click="onInstallDictionary">
        {{ installing ? '安装中...' : '安装/更新混合词典' }}
      </button>
      <p v-if="installProgressText" class="muted">{{ installProgressText }}</p>
      <p v-if="installProgressDetails" class="muted">{{ installProgressDetails }}</p>
      <p v-if="lastError" class="error">{{ lastError }}</p>
      <div v-if="installedMeta" class="sync-panel">
        <strong>完整 ECDICT 后台离线包</strong>
        <p class="muted">核心词库可用后按前缀分桶缓存；断网或暂停后可继续，完整词条不会批量写入 IndexedDB。</p>
        <progress :value="fullCacheProgress" max="1" />
        <button class="btn" type="button" @click="toggleFullDictionaryDownload">{{ fullCachePaused ? '继续下载' : '暂停下载' }}</button>
      </div>
    </article>

    <article class="result-section">
      <h2>背诵设置</h2>
      <label class="setting-row">
        <span>自动播放发音</span>
        <input
          type="checkbox"
          :checked="settings.autoPronunciation"
          @change="onUpdateBoolean('autoPronunciation', $event)"
        />
      </label>

      <label class="setting-row">
        <span>语速 {{ settings.speechRate.toFixed(1) }}</span>
        <input
          type="range"
          min="0.7"
          max="1.3"
          step="0.1"
          :value="settings.speechRate"
          @input="onUpdateNumber('speechRate', $event)"
        />
      </label>

      <label class="setting-row">
        <span>TTS 引擎</span>
        <select class="inline-input" :value="settings.ttsEngine" @change="onUpdateEngine">
          <option value="auto">自动（推荐）</option>
          <option value="browser">系统 TTS</option>
          <option value="youdao">Youdao 免费语音</option>
          <option value="google">Google 免费语音</option>
          <option value="dictionaryapi">DictionaryAPI 语音</option>
        </select>
      </label>

      <label class="setting-row">
        <span>每日新词目标</span>
        <input
          type="number"
          min="0"
          max="200"
          :value="settings.dailyNewLimit"
          @change="onUpdateNumber('dailyNewLimit', $event)"
        />
      </label>

      <label class="setting-row">
        <span>每日复习目标</span>
        <input
          type="number"
          min="0"
          max="500"
          :value="settings.dailyReviewLimit"
          @change="onUpdateNumber('dailyReviewLimit', $event)"
        />
      </label>
      <p class="muted settings-hint">用于首次安排；完成后仍可继续加学。</p>
    </article>

    <article class="result-section">
      <h2>AI 词典增强（Deepseek）</h2>
      <label class="setting-stack">
        <span>API Key</span>
        <input
          type="password"
          class="inline-input"
          :value="settings.deepseekApiKey"
          placeholder="sk-..."
          @change="onUpdateString('deepseekApiKey', $event)"
        />
      </label>

      <label class="setting-stack">
        <span>Base URL</span>
        <input
          type="text"
          class="inline-input"
          :value="settings.deepseekBaseUrl"
          @change="onUpdateString('deepseekBaseUrl', $event)"
        />
      </label>

      <label class="setting-stack">
        <span>Model</span>
        <input
          type="text"
          class="inline-input"
          :value="settings.deepseekModel"
          @change="onUpdateString('deepseekModel', $event)"
        />
      </label>

      <label class="setting-row">
        <span>文章默认难度</span>
        <select class="inline-input" :value="settings.articleLevel" @change="onUpdateArticleLevel">
          <option value="A2">A2</option><option value="B1">B1</option><option value="B2">B2</option><option value="C1">C1</option>
        </select>
      </label>

      <label class="setting-row">
        <span><strong>API Key 随账号同步</strong><small>默认关闭；仅在登录后可用</small></span>
        <input type="checkbox" :checked="settings.syncDeepseekApiKey" @change="onToggleKeySync" />
      </label>
      <p v-if="settings.syncDeepseekApiKey" class="warning-note">Key 会以明文保存到独立的 Supabase 表。RLS 可阻止其他普通用户访问，但项目数据库管理员和高权限凭据仍可读取。</p>
      <p class="muted">Key 不会进入普通同步记录、备份、文章会话或日志。AI 同时用于词典增强和今日语境文章。</p>
    </article>

    <article class="result-section">
      <h2>云同步（Supabase）</h2>
      <p class="muted">{{ cloudStatusText }}</p>
      <p v-if="cloudLastSyncAt" class="muted">上次同步：{{ cloudLastSyncAt }}</p>
      <p v-if="cloudMessage" class="muted">{{ cloudMessage }}</p>

      <div v-if="!cloudAuth.configured" class="sync-panel">
        <p class="muted">在部署环境设置 VITE_SUPABASE_URL 和 VITE_SUPABASE_PUBLISHABLE_KEY 后启用。</p>
      </div>

      <div v-else-if="!cloudAuth.signedIn" class="sync-panel">
        <label class="setting-stack">
          <span>邮箱</span>
          <input v-model="cloudEmail" type="email" class="inline-input" autocomplete="email" />
        </label>
        <label class="setting-stack">
          <span>密码</span>
          <input
            v-model="cloudPassword"
            type="password"
            class="inline-input"
            autocomplete="current-password"
          />
        </label>
        <div class="actions">
          <button class="btn btn-primary" :disabled="cloudBusy || !cloudEmail || !cloudPassword" @click="onCloudSignIn">
            {{ cloudBusy ? '登录中...' : '登录云同步' }}
          </button>
        </div>
        <p class="muted">未登录时不会读取或写入云端，访客只使用自己的本地浏览器数据。</p>
      </div>

      <div v-else class="sync-panel">
        <div class="actions">
          <button class="btn" :disabled="cloudBusy" @click="onPreviewCloudSync('bidirectional')">预览双向同步</button>
          <button class="btn btn-primary" :disabled="cloudBusy" @click="onRunCloudSync('upload')">
            首次上传本地数据
          </button>
          <button class="btn" :disabled="cloudBusy" @click="onRunCloudSync('download')">从云端恢复</button>
          <button class="btn btn-primary" :disabled="cloudBusy" @click="onRunCloudSync('bidirectional')">
            立即双向同步
          </button>
          <button class="btn btn-quiet" :disabled="cloudBusy" @click="onCloudSignOut">退出云同步</button>
        </div>

        <div v-if="cloudPreview" class="sync-preview-grid">
          <div>
            <span>将上传</span>
            <strong>{{ cloudPreview.upload }}</strong>
          </div>
          <div>
            <span>将下载</span>
            <strong>{{ cloudPreview.download }}</strong>
          </div>
          <div>
            <span>冲突</span>
            <strong>{{ cloudPreview.conflicts }}</strong>
          </div>
          <div>
            <span>删除</span>
            <strong>{{ cloudPreview.deletions }}</strong>
          </div>
        </div>

        <p v-if="cloudPreview?.blockedSettings.length" class="muted">
          不上传敏感设置：{{ cloudPreview.blockedSettings.join('、') }}
        </p>
      </div>
    </article>

    <article class="result-section">
      <h2>数据与备份</h2>
      <p class="muted">单词总数：{{ wordbookStats.total }}，活跃：{{ wordbookStats.active }}</p>
      <div class="actions">
        <button class="btn" @click="onExport">导出备份</button>
        <label class="btn">
          导入备份
          <input type="file" accept="application/json" class="file-input" @change="onImport" />
        </label>
      </div>
    </article>
  </section>
</template>
