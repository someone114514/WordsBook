<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { BookOpen, BrainCircuit, ChevronDown, Cloud, DatabaseBackup, Sparkles } from 'lucide-vue-next'
import { useRoute, useRouter } from 'vue-router'
import { notify } from '../app/feedback'
import { setWakeLockOwner } from '../app/screenWakeLock'
import { parseSettingsSection, type SettingsSection } from '../app/settingsSections'
import { setCriticalActivity, useAppLifecycle } from '../app/useAppLifecycle'
import { useDictionaryStore } from '../modules/dictionary/dictionaryStore'
import { exportUserData, importUserData } from '../modules/settings/backupService'
import { useSettingsStore } from '../modules/settings/settingsStore'
import {
  getCloudAuthState,
  signInCloud,
  signOutCloud,
  signUpCloud,
  type CloudAuthState,
} from '../modules/sync/cloudAuthService'
import { getLastSuccessfulSyncAt, previewCloudSync, runCloudSync } from '../modules/sync/syncEngine'
import { getSupabaseClient, isSupabaseConfigured } from '../modules/sync/supabaseClient'
import { SupabaseCloudSyncRemote } from '../modules/sync/supabaseRemote'
import { deleteDeepseekSecret, syncDeepseekSecret, unloadDeepseekSecret, uploadDeepseekSecret } from '../modules/sync/cloudSecretService'
import type { CloudSyncMode, SyncPreview, SyncResult } from '../modules/sync/syncTypes'
import { getWordbookStats } from '../modules/wordbook/wordbookService'
import {
  getFsrsPersonalizationStatus,
  describeFsrsError,
  isFsrsTrainingMode,
  optimizeFsrsParameters,
  type FsrsOptimizationProgress,
  type FsrsPersonalizationStatus,
} from '../modules/review/fsrsPersonalizationService'

const route = useRoute()
const router = useRouter()
const lifecycle = useAppLifecycle()
const { canInstall, standalone } = lifecycle
const settingsStore = useSettingsStore()
const dictionaryStore = useDictionaryStore()
const appVersion = __APP_VERSION__
const appUpdatedAt = __APP_UPDATED_AT__

const { settings, loaded: settingsLoaded } = storeToRefs(settingsStore)
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
const cloudPasswordConfirm = ref('')
const cloudAuthMode = ref<'sign-in' | 'sign-up'>('sign-in')
const cloudBusy = ref(false)
const cloudStateLoading = ref(true)
const cloudOperation = ref<'idle' | 'auth-check' | 'sign-in' | 'sign-up' | 'preview' | 'upload' | 'download' | 'bidirectional' | 'sign-out' | 'key-sync'>('auth-check')
const cloudMessage = ref('')
const cloudMessageTone = ref<'info' | 'success' | 'error'>('info')
const cloudPreview = ref<SyncPreview | null>(null)
const cloudLastResult = ref<SyncResult | null>(null)
const cloudLastSyncAt = ref<string | null>(null)
const fsrsStatus = ref<FsrsPersonalizationStatus | null>(null)
const fsrsBusy = ref(false)
const fsrsProgress = ref('')
const fsrsMessage = ref('')
const fsrsMessageTone = ref<'success' | 'info' | 'error'>('info')
const fsrsTechnicalDetails = ref('')
const fsrsTrainingMode = isFsrsTrainingMode()
const FSRS_TRAINING_PENDING_KEY = 'wordsbook:fsrs-training-pending'
const aiKeyInput = ref<HTMLInputElement | null>(null)
const aiBaseUrlInput = ref<HTMLInputElement | null>(null)
const aiModelInput = ref<HTMLInputElement | null>(null)
const aiSettingsMessage = ref('')
const aiSettingsBusy = ref(false)
const aiFormDirty = ref(false)
const SETTINGS_SECTION_KEY = 'wordsbook:settings:last-section:v1'
const storedSection = parseSettingsSection(localStorage.getItem(SETTINGS_SECTION_KEY))
const openSection = ref<SettingsSection>(
  fsrsTrainingMode ? 'fsrs' : parseSettingsSection(route.query.section) ?? storedSection ?? 'dictionary',
)

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

const cloudOperationText = computed(() => ({
  idle: '',
  'auth-check': '正在检查云同步登录状态…',
  'sign-in': '正在安全登录…',
  'sign-up': '正在创建云同步账号…',
  preview: '正在读取本机与云端数据并生成预览…',
  upload: '正在备份并上传本机数据…',
  download: '正在从云端恢复数据…',
  bidirectional: '正在比较并合并本机与云端数据…',
  'sign-out': '正在退出云同步…',
  'key-sync': '正在同步 DeepSeek Key…',
}[cloudOperation.value]))

const keySyncStatus = computed(() => {
  if (!cloudAuth.value.signedIn) return '登录云同步账号后可以开启'
  return settings.value.syncDeepseekApiKey ? '已开启：Key 将随当前账号同步' : '已关闭：Key 只保存在这台设备'
})

const fsrsStatusText = computed(() => {
  const status = fsrsStatus.value
  if (!status) return '正在读取复习证据…'
  if (status.active) return `个性化参数已启用 · ${status.effectiveReviewCount} 条有效评分`
  if (!status.eligible) {
    return `${status.effectiveReviewCount}/${status.requiredReviewCount} 条有效每日首次评分`
  }
  if (!fsrsTrainingMode) return '数据已足够，可在本机训练并验证个性化参数'
  if (!status.runtimeAvailable) return '训练环境尚未就绪'
  return '训练环境已就绪'
})

async function selectSection(section: SettingsSection, scroll = true): Promise<void> {
  openSection.value = section
  localStorage.setItem(SETTINGS_SECTION_KEY, section)
  if (route.query.section !== section) {
    await router.replace({ query: { ...route.query, section } })
  }
  if (scroll) {
    await nextTick()
    document.getElementById(`settings-section-${section}`)?.scrollIntoView({ block: 'start' })
  }
}

watch(() => route.query.section, (value) => {
  const section = parseSettingsSection(value)
  if (section && section !== openSection.value) void selectSection(section, true)
})

const fsrsRuntimeHint = computed(() => {
  const status = fsrsStatus.value
  if (!status || status.runtimeAvailable) return ''
  return ({
    'training-mode-required': '需要进入独立训练模式。',
    'insecure-context': '当前页面不是安全连接，浏览器无法启用本地优化器。',
    'shared-array-buffer-unavailable': '当前浏览器版本未开放训练所需的共享内存能力。',
    'cross-origin-isolation-unavailable': '训练页面未获得浏览器隔离；请更新浏览器或重新进入训练模式。',
    ready: '',
  })[status.runtimeReason]
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
    refreshFsrsStatus(),
    refreshCloudState(),
  ])
    .then(() => undefined)
    .finally(() => {
      settingsRefreshPromise = null
    })

  return settingsRefreshPromise
}

onMounted(async () => {
  await selectSection(openSection.value, Boolean(route.query.section || fsrsTrainingMode))
  await initializeSettingsView({ force: true })
  if (
    fsrsTrainingMode
    && sessionStorage.getItem(FSRS_TRAINING_PENDING_KEY)
    && fsrsStatus.value?.eligible
    && fsrsStatus.value.runtimeAvailable
  ) {
    sessionStorage.removeItem(FSRS_TRAINING_PENDING_KEY)
    await onOptimizeFsrs()
  }
})

onActivated(() => {
  void initializeSettingsView()
})

onBeforeUnmount(() => {
  setCriticalActivity('fsrs-training', false)
  setCriticalActivity('settings-form', false)
  void setWakeLockOwner('fsrs-training', false)
})

async function refreshStats() {
  wordbookStats.value = await getWordbookStats()
}

async function refreshFsrsStatus() {
  fsrsStatus.value = await getFsrsPersonalizationStatus()
}

async function onOptimizeFsrs() {
  if (fsrsBusy.value) return
  if (!fsrsTrainingMode) {
    const target = new URL(window.location.href)
    target.searchParams.set('fsrs-training', '1')
    sessionStorage.setItem(FSRS_TRAINING_PENDING_KEY, '1')
    fsrsMessageTone.value = 'info'
    fsrsMessage.value = '正在进入本地训练环境…'
    await nextTick()
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
    window.location.assign(target.toString())
    return
  }
  if (!fsrsStatus.value?.runtimeAvailable) {
    fsrsMessageTone.value = 'error'
    fsrsMessage.value = fsrsRuntimeHint.value || '当前浏览器无法启用本地训练环境'
    return
  }
  fsrsBusy.value = true
  fsrsMessage.value = ''
  fsrsTechnicalDetails.value = ''
  fsrsProgress.value = '正在准备训练集与留出集…'
  setCriticalActivity('fsrs-training', true)
  if (fsrsStatus.value) fsrsStatus.value.diagnostics.workerStage = 'starting'
  await setWakeLockOwner('fsrs-training', true)
  try {
    const result = await optimizeFsrsParameters((progress: FsrsOptimizationProgress) => {
      if (progress.phase === 'initializing' && progress.current === 1 && fsrsStatus.value) {
        fsrsStatus.value.diagnostics.workerStage = 'ready'
      }
      const count = progress.total && progress.current !== undefined ? ` ${progress.current}/${progress.total}` : ''
      fsrsProgress.value = ({
        preparing: '正在准备训练集与留出集…',
        initializing: '正在启动本地训练组件…',
        training: `正在训练个性化参数${count}`,
        validating: '正在验证候选参数…',
        rebuilding: `正在分批重建长期记忆状态${count}`,
        saving: '正在安全保存训练结果…',
      })[progress.phase]
    })
    fsrsMessageTone.value = result.lastOutcome === 'active' ? 'success' : 'info'
    fsrsMessage.value = result.lastOutcome === 'active'
      ? '候选参数在留出集的 Log loss 与 RMSE 均优于默认参数，已启用并重算长期状态。'
      : '候选参数未同时优于默认参数，已安全保留当前调度参数。'
    notify(result.lastOutcome === 'active' ? 'FSRS 个性化参数已安全启用。' : '验证完成，已保留当前参数。', { tone: 'success' })
    await refreshFsrsStatus()
    if (fsrsTrainingMode) window.setTimeout(leaveFsrsTrainingMode, 1200)
  } catch (error) {
    const failure = describeFsrsError(error)
    if (fsrsStatus.value) fsrsStatus.value.diagnostics.workerStage = 'failed'
    fsrsMessageTone.value = 'error'
    fsrsMessage.value = failure.message
    fsrsTechnicalDetails.value = failure.technicalDetails
    notify('FSRS 训练未完成，现有学习进度不受影响。', { tone: 'error' })
  } finally {
    fsrsProgress.value = ''
    fsrsBusy.value = false
    setCriticalActivity('fsrs-training', false)
    await setWakeLockOwner('fsrs-training', false)
  }
}

function leaveFsrsTrainingMode() {
  const target = new URL(window.location.href)
  target.searchParams.delete('fsrs-training')
  sessionStorage.removeItem(FSRS_TRAINING_PENDING_KEY)
  window.location.replace(target.toString())
}

async function copyFsrsDiagnostics() {
  if (!fsrsStatus.value) return
  const payload = {
    ...fsrsStatus.value.diagnostics,
    effectiveReviewCount: fsrsStatus.value.effectiveReviewCount,
    trainableItemCount: fsrsStatus.value.trainableItemCount,
    lastFailure: fsrsTechnicalDetails.value || undefined,
  }
  try {
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
    fsrsMessageTone.value = 'info'
    fsrsMessage.value = '训练环境诊断已复制'
  } catch {
    fsrsMessageTone.value = 'error'
    fsrsMessage.value = '无法自动复制，请检查浏览器的剪贴板权限'
  }
}

async function onInstallApp(): Promise<void> {
  const installed = await lifecycle.promptInstall()
  if (installed) notify('WordsBook 已添加到主屏幕。', { tone: 'success' })
  else notify('在 Safari 分享菜单中选择“添加到主屏幕”。')
}

async function onUpdateBoolean(key: 'autoPronunciation', event: Event) {
  const target = event.target as HTMLInputElement
  const previous = settings.value[key]
  try {
    await settingsStore.update({ [key]: target.checked })
    notify('设置已保存。', { tone: 'success' })
  } catch {
    target.checked = previous
    notify('保存失败，已恢复原设置。', { tone: 'error' })
  }
}

async function onUpdateNumber(
  key: 'dailyNewLimit' | 'dailyReviewLimit' | 'roundWordCount' | 'articleEveryRounds' | 'practiceQuestionLimit' | 'speechRate',
  event: Event,
): Promise<void> {
  const target = event.target as HTMLInputElement
  const value = Number(target.value)
  if (!Number.isFinite(value)) {
    return
  }
  const previous = settings.value[key]
  try {
    await settingsStore.update({ [key]: value })
    notify('设置已保存。', { tone: 'success' })
  } catch {
    target.value = String(previous)
    notify('保存失败，已恢复原设置。', { tone: 'error' })
  }
}

async function onUpdateEngine(event: Event): Promise<void> {
  const target = event.target as HTMLSelectElement
  const previous = settings.value.ttsEngine
  try {
    await settingsStore.update({
      ttsEngine: target.value as 'auto' | 'browser' | 'youdao' | 'google' | 'dictionaryapi',
    })
    notify('发音设置已保存。', { tone: 'success' })
  } catch {
    target.value = previous
    notify('保存失败，已恢复原设置。', { tone: 'error' })
  }
}

async function onUpdateArticleLevel(event: Event): Promise<void> {
  const target = event.target as HTMLSelectElement
  const previous = settings.value.articleLevel
  try {
    await settingsStore.update({ articleLevel: target.value as 'A2' | 'B1' | 'B2' | 'C1' })
    notify('文章难度已保存。', { tone: 'success' })
  } catch {
    target.value = previous
    notify('保存失败，已恢复原设置。', { tone: 'error' })
  }
}

async function onUpdateDefinitionLanguage(event: Event): Promise<void> {
  const target = event.target as HTMLSelectElement
  const previous = settings.value.definitionLanguage
  try {
    await settingsStore.update({
      definitionLanguage: target.value as 'adaptive' | 'english-first' | 'chinese-first',
    })
    notify('释义语言已保存。', { tone: 'success' })
  } catch {
    target.value = previous
    notify('保存失败，已恢复原设置。', { tone: 'error' })
  }
}

async function onUpdateString(
  key: 'deepseekApiKey' | 'deepseekBaseUrl' | 'deepseekModel',
  event: Event,
): Promise<void> {
  const target = event.target as HTMLInputElement
  await settingsStore.update({ [key]: target.value.trim() })
  aiFormDirty.value = false
  setCriticalActivity('settings-form', false)
  if (key === 'deepseekApiKey' && settings.value.syncDeepseekApiKey && cloudAuth.value.signedIn) {
    cloudBusy.value = true
    cloudOperation.value = 'key-sync'
    try {
      if (target.value.trim()) await uploadDeepseekSecret(target.value.trim())
      else await deleteDeepseekSecret()
      cloudMessageTone.value = 'success'
      cloudMessage.value = target.value.trim() ? 'DeepSeek Key 已同步到当前账号' : '本地与云端 Key 已删除'
    } catch (error) {
      cloudMessageTone.value = 'error'
      cloudMessage.value = error instanceof Error ? error.message : String(error)
    } finally {
      cloudBusy.value = false
      cloudOperation.value = 'idle'
    }
  }
}

async function saveAiSettings(): Promise<void> {
  aiSettingsBusy.value = true
  aiSettingsMessage.value = ''
  try {
    if (!settingsLoaded.value) await settingsStore.initialize()
    const deepseekApiKey = aiKeyInput.value?.value.trim() ?? settings.value.deepseekApiKey
    const deepseekBaseUrl = aiBaseUrlInput.value?.value.trim() ?? settings.value.deepseekBaseUrl
    const deepseekModel = aiModelInput.value?.value.trim() ?? settings.value.deepseekModel
    await settingsStore.update({ deepseekApiKey, deepseekBaseUrl, deepseekModel })
    if (settings.value.syncDeepseekApiKey && cloudAuth.value.signedIn) {
      if (deepseekApiKey) await uploadDeepseekSecret(deepseekApiKey)
      else await deleteDeepseekSecret()
    }
    aiSettingsMessage.value = deepseekApiKey
      ? 'AI 设置已保存到当前设备'
      : 'AI 设置已保存；当前未配置 API Key'
    notify('AI 设置已保存。', { tone: 'success' })
    aiFormDirty.value = false
    setCriticalActivity('settings-form', false)
  } catch (error) {
    aiSettingsMessage.value = error instanceof Error ? error.message : String(error)
    notify('AI 设置保存失败，输入内容仍保留在页面中。', { tone: 'error' })
  } finally {
    aiSettingsBusy.value = false
  }
}

function markAiFormDirty(): void {
  aiFormDirty.value = true
  setCriticalActivity('settings-form', true)
}

async function onToggleKeySync(event: Event) {
  const enabled = (event.target as HTMLInputElement).checked
  cloudBusy.value = true
  cloudOperation.value = 'key-sync'
  cloudMessageTone.value = 'info'
  try {
    await settingsStore.update({ syncDeepseekApiKey: enabled })
    if (!enabled) { cloudMessage.value = '已关闭 Key 云同步；云端已有 Key 不会自动删除'; return }
    if (!cloudAuth.value.signedIn) { cloudMessage.value = '请先登录云同步账号，再开启 Key 同步'; await settingsStore.update({ syncDeepseekApiKey: false }); return }
    const value = await syncDeepseekSecret()
    await settingsStore.initialize()
    cloudMessageTone.value = 'success'
    cloudMessage.value = value ? 'DeepSeek Key 已与当前账号同步' : '已开启；填写 Key 后会同步到当前账号'
  } catch (error) {
    cloudMessageTone.value = 'error'
    cloudMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    cloudBusy.value = false
    cloudOperation.value = 'idle'
  }
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
  cloudStateLoading.value = true
  if (!cloudBusy.value) cloudOperation.value = 'auth-check'
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
    cloudMessageTone.value = 'error'
  } finally {
    cloudStateLoading.value = false
    if (!cloudBusy.value) cloudOperation.value = 'idle'
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
  cloudOperation.value = 'sign-in'
  cloudMessage.value = ''
  try {
    cloudAuth.value = await signInCloud(cloudEmail.value.trim(), cloudPassword.value)
    cloudPassword.value = ''
    if (settings.value.syncDeepseekApiKey) {
      await syncDeepseekSecret()
      await settingsStore.initialize()
    }
    cloudMessage.value = '云同步已登录'
    cloudMessageTone.value = 'success'
  } catch (error) {
    cloudMessage.value = error instanceof Error ? error.message : String(error)
    cloudMessageTone.value = 'error'
  } finally {
    cloudBusy.value = false
    cloudOperation.value = 'idle'
  }
}

async function onCloudSignUp() {
  if (cloudPassword.value !== cloudPasswordConfirm.value) {
    cloudMessageTone.value = 'error'
    cloudMessage.value = '两次输入的密码不一致'
    return
  }
  cloudBusy.value = true
  cloudOperation.value = 'sign-up'
  cloudMessage.value = ''
  try {
    const result = await signUpCloud(cloudEmail.value.trim(), cloudPassword.value)
    cloudAuth.value = result.auth
    cloudPassword.value = ''
    cloudPasswordConfirm.value = ''
    cloudMessageTone.value = 'success'
    cloudMessage.value = result.confirmationRequired ? '账号已创建，请前往邮箱确认后再登录' : '账号已创建并登录'
    if (!result.confirmationRequired) cloudAuthMode.value = 'sign-in'
  } catch (error) {
    cloudMessageTone.value = 'error'
    cloudMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    cloudBusy.value = false
    cloudOperation.value = 'idle'
  }
}

async function onCloudSignOut() {
  cloudBusy.value = true
  cloudOperation.value = 'sign-out'
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
    cloudMessageTone.value = 'success'
  } catch (error) {
    cloudMessageTone.value = 'error'
    cloudMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    cloudBusy.value = false
    cloudOperation.value = 'idle'
  }
}

async function onPreviewCloudSync(mode: CloudSyncMode) {
  cloudBusy.value = true
  cloudOperation.value = 'preview'
  cloudMessage.value = ''
  try {
    cloudPreview.value = await previewCloudSync(getCloudRemote(), mode)
    cloudMessage.value = '同步预览已生成'
    cloudMessageTone.value = 'success'
  } catch (error) {
    cloudMessage.value = error instanceof Error ? error.message : String(error)
    cloudMessageTone.value = 'error'
  } finally {
    cloudBusy.value = false
    cloudOperation.value = 'idle'
  }
}

async function onRunCloudSync(mode: CloudSyncMode) {
  cloudBusy.value = true
  cloudOperation.value = mode
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
    cloudMessageTone.value = 'success'
  } catch (error) {
    cloudMessage.value = error instanceof Error ? error.message : String(error)
    cloudMessageTone.value = 'error'
  } finally {
    cloudBusy.value = false
    cloudOperation.value = 'idle'
  }
}
</script>

<template>
  <section class="panel">
    <Transition name="soft-fade-slide">
      <p v-if="message" class="success">{{ message }}</p>
    </Transition>

    <details id="settings-section-dictionary" class="settings-group" :open="openSection === 'dictionary'">
      <summary class="settings-group-summary" @click.prevent="selectSection('dictionary', true)">
        <span class="settings-group-title"><span class="settings-group-icon"><BookOpen :size="20" aria-hidden="true" /></span><span><strong>词典与学习</strong><small>离线词典、发音与每日目标</small></span></span>
        <ChevronDown class="settings-group-chevron" :size="20" aria-hidden="true" />
      </summary>
      <div class="settings-group-content">
    <article class="result-section settings-card">
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

    <article class="result-section settings-card">
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
      <label class="setting-row">
        <span>每批目标词（8–12）</span>
        <input
          type="number"
          min="8"
          max="12"
          :value="settings.roundWordCount"
          @change="onUpdateNumber('roundWordCount', $event)"
        />
      </label>

      <label class="setting-row">
        <span>每日语境练习题数上限</span>
        <input
          type="number"
          min="0"
          max="12"
          :value="settings.practiceQuestionLimit"
          @change="onUpdateNumber('practiceQuestionLimit', $event)"
        />
      </label>
      <p class="muted settings-hint">每批最多加入 5 个新词。设为 0 可关闭语境练习；文章与卡片按批循环。</p>
    </article>
      </div>
    </details>

    <details id="settings-section-fsrs" class="settings-group" :open="openSection === 'fsrs'">
      <summary class="settings-group-summary" @click.prevent="selectSection('fsrs', true)">
        <span class="settings-group-title"><span class="settings-group-icon"><BrainCircuit :size="20" aria-hidden="true" /></span><span><strong>FSRS 个性化</strong><small>长期复习与训练</small></span></span>
        <ChevronDown class="settings-group-chevron" :size="20" aria-hidden="true" />
      </summary>
      <div class="settings-group-content">
    <article class="result-section settings-card">
      <div class="fsrs-summary-row">
        <span :class="['sync-status-badge', { connected: fsrsStatus?.active, loading: fsrsBusy }]">{{ fsrsBusy ? '训练中' : fsrsStatus?.active ? '已启用' : '默认参数' }}</span>
        <p class="muted">{{ fsrsStatusText }}</p>
      </div>
      <div v-if="fsrsBusy" class="sync-progress" role="status" aria-live="polite"><span class="sync-spinner" aria-hidden="true" /><span>{{ fsrsProgress || '正在训练与验证…' }}</span></div>
      <p v-if="fsrsMessage" :class="['sync-message', `sync-message-${fsrsMessageTone}`]" :role="fsrsMessageTone === 'error' ? 'alert' : 'status'">{{ fsrsMessage }}</p>
      <button class="btn btn-primary" type="button" :disabled="fsrsBusy || !fsrsStatus?.eligible || (fsrsTrainingMode && !fsrsStatus.runtimeAvailable)" @click="onOptimizeFsrs">
        {{ !fsrsTrainingMode ? '训练个性化复习' : fsrsStatus?.active ? '重新训练并验证' : '开始训练' }}
      </button>
      <details class="settings-advanced-details">
        <summary>算法与诊断</summary>
        <div class="settings-advanced-content">
          <div v-if="fsrsStatus" class="fsrs-metrics-list">
            <div><span>有效评分</span><strong>{{ fsrsStatus.effectiveReviewCount }}</strong></div>
            <div><span>可训练样本</span><strong>{{ fsrsStatus.trainableItemCount }}</strong></div>
            <div><span>目标保持率</span><strong>90%</strong></div>
          </div>
          <div v-if="fsrsStatus?.record?.defaultMetrics && fsrsStatus.record.candidateMetrics" class="sync-panel">
            <strong>最近一次验证</strong>
            <p class="muted">
              默认 Log loss {{ fsrsStatus.record.defaultMetrics.logLoss.toFixed(4) }} / RMSE {{ fsrsStatus.record.defaultMetrics.rmseBins.toFixed(4) }}
              · 候选 Log loss {{ fsrsStatus.record.candidateMetrics.logLoss.toFixed(4) }} / RMSE {{ fsrsStatus.record.candidateMetrics.rmseBins.toFixed(4) }}
            </p>
          </div>
          <div v-if="fsrsStatus?.eligible && (!fsrsStatus.runtimeAvailable || fsrsTrainingMode)" class="sync-panel fsrs-runtime-panel">
            <strong>{{ fsrsStatus.runtimeAvailable ? '训练环境可用' : '训练环境诊断' }}</strong>
            <p v-if="fsrsRuntimeHint" class="muted">{{ fsrsRuntimeHint }}</p>
            <p class="muted">隔离 {{ fsrsStatus.diagnostics.crossOriginIsolated ? '可用' : '不可用' }} · 共享内存 {{ fsrsStatus.diagnostics.sharedArrayBuffer ? '可用' : '不可用' }} · 训练组件 {{ fsrsBusy ? '运行中' : '待启动' }}</p>
            <div class="actions">
              <button class="btn btn-quiet" type="button" @click="copyFsrsDiagnostics">复制诊断</button>
              <button v-if="fsrsTrainingMode && !fsrsBusy" class="btn btn-quiet" type="button" @click="leaveFsrsTrainingMode">退出训练模式</button>
            </div>
          </div>
          <p class="muted settings-hint">只使用每个单词每天第一次有效、无提示的评分；至少 400 条后开放。候选参数验证优于当前参数时才会启用。</p>
          <details v-if="fsrsTechnicalDetails" class="technical-details">
            <summary>技术详情</summary>
            <pre>{{ fsrsTechnicalDetails }}</pre>
            <button class="btn btn-quiet" type="button" @click="copyFsrsDiagnostics">复制技术详情</button>
          </details>
        </div>
      </details>
    </article>
      </div>
    </details>

    <details id="settings-section-ai" class="settings-group" :open="openSection === 'ai'">
      <summary class="settings-group-summary" @click.prevent="selectSection('ai', true)">
        <span class="settings-group-title"><span class="settings-group-icon"><Sparkles :size="20" aria-hidden="true" /></span><span><strong>AI 与语境</strong><small>DeepSeek、释义语言与文章难度</small></span></span>
        <ChevronDown class="settings-group-chevron" :size="20" aria-hidden="true" />
      </summary>
      <div class="settings-group-content">
    <article class="result-section settings-card">
      <h2>AI 词典增强（Deepseek）</h2>
      <label class="setting-stack">
        <span><strong>API Key</strong><small>默认仅保存在当前设备</small></span>
        <input
          ref="aiKeyInput"
          type="password"
          class="inline-input"
          :value="settings.deepseekApiKey"
          :disabled="!settingsLoaded || cloudOperation === 'key-sync'"
          placeholder="sk-..."
          @input="markAiFormDirty"
          @change="onUpdateString('deepseekApiKey', $event)"
        />
      </label>

      <label class="setting-stack">
        <span>Base URL</span>
        <input
          ref="aiBaseUrlInput"
          type="text"
          class="inline-input"
          :disabled="!settingsLoaded"
          :value="settings.deepseekBaseUrl"
          @input="markAiFormDirty"
          @change="onUpdateString('deepseekBaseUrl', $event)"
        />
      </label>

      <label class="setting-stack">
        <span>Model</span>
        <input
          ref="aiModelInput"
          type="text"
          class="inline-input"
          :disabled="!settingsLoaded"
          :value="settings.deepseekModel"
          @input="markAiFormDirty"
          @change="onUpdateString('deepseekModel', $event)"
        />
      </label>

      <label class="setting-row">
        <span>文章默认难度</span>
        <select class="inline-input" :value="settings.articleLevel" @change="onUpdateArticleLevel">
          <option value="A2">A2</option><option value="B1">B1</option><option value="B2">B2</option><option value="C1">C1</option>
        </select>
      </label>
      <div class="action-row">
        <button class="btn btn-primary" type="button" :disabled="aiSettingsBusy || !settingsLoaded" @click="saveAiSettings">
          {{ aiSettingsBusy ? '正在保存…' : '保存 AI 设置' }}
        </button>
        <p v-if="aiSettingsMessage" class="muted" role="status">{{ aiSettingsMessage }}</p>
      </div>
      <label class="setting-row">
        <span>卡片释义语言</span>
        <select class="inline-input" :value="settings.definitionLanguage" @change="onUpdateDefinitionLanguage">
          <option value="adaptive">随水平自适应（推荐）</option>
          <option value="english-first">英文释义优先</option>
          <option value="chinese-first">中文核心义优先</option>
        </select>
      </label>

      <div :class="['key-sync-status', { active: settings.syncDeepseekApiKey }]">
        <div><strong>{{ settings.syncDeepseekApiKey ? '随账号同步' : '仅本机保存' }}</strong><p>{{ keySyncStatus }}</p></div>
        <label class="sync-toggle"><span class="sr-only">API Key 随账号同步</span><input type="checkbox" :checked="settings.syncDeepseekApiKey" :disabled="cloudBusy || cloudStateLoading || !cloudAuth.signedIn" @change="onToggleKeySync" /></label>
      </div>
      <div v-if="cloudOperation === 'key-sync'" class="sync-progress" role="status" aria-live="polite"><span class="sync-spinner" aria-hidden="true" /><span>{{ cloudOperationText }}</span></div>
      <p v-if="settings.syncDeepseekApiKey" class="warning-note">Key 会以明文保存到独立的 Supabase 表。RLS 可阻止其他普通用户访问，但项目数据库管理员和高权限凭据仍可读取。</p>
      <p class="muted">Key 不会进入普通同步记录、备份、文章会话或日志。AI 同时用于词典增强和今日语境文章。</p>
    </article>
      </div>
    </details>

    <details id="settings-section-sync" class="settings-group" :open="openSection === 'sync'">
      <summary class="settings-group-summary" @click.prevent="selectSection('sync', true)">
        <span class="settings-group-title"><span class="settings-group-icon"><Cloud :size="20" aria-hidden="true" /></span><span><strong>同步与安全</strong><small>账号、云端同步与敏感数据</small></span></span>
        <ChevronDown class="settings-group-chevron" :size="20" aria-hidden="true" />
      </summary>
      <div class="settings-group-content">
    <article class="result-section settings-card">
      <div class="sync-heading"><div><p class="eyebrow">多设备数据</p><h2>云同步</h2></div><span :class="['sync-status-badge', { connected: cloudAuth.signedIn, loading: cloudStateLoading }]">{{ cloudStateLoading ? '检查中' : cloudAuth.signedIn ? '已连接' : cloudAuth.configured ? '未登录' : '未配置' }}</span></div>
      <p class="muted">{{ cloudStatusText }}<template v-if="cloudLastSyncAt"> · 上次同步 {{ cloudLastSyncAt }}</template></p>

      <div v-if="cloudStateLoading || cloudBusy" class="sync-progress" role="status" aria-live="polite"><span class="sync-spinner" aria-hidden="true" /><span>{{ cloudOperationText || '正在加载云同步状态…' }}</span></div>
      <p v-if="cloudMessage" :class="['sync-message', `sync-message-${cloudMessageTone}`]" :role="cloudMessageTone === 'error' ? 'alert' : 'status'">{{ cloudMessage }}</p>

      <div v-if="!cloudAuth.configured" class="sync-panel">
        <p class="muted">在部署环境设置 VITE_SUPABASE_URL 和 VITE_SUPABASE_PUBLISHABLE_KEY 后启用。</p>
      </div>

      <div v-else-if="cloudStateLoading" class="sync-panel sync-panel-loading" aria-hidden="true"><span /><span /><span /></div>

      <div v-else-if="!cloudAuth.signedIn" class="sync-panel">
        <ol class="sync-guide">
          <li class="active"><span>1</span><div><strong>登录或注册</strong><p>账号用于区分不同用户的数据。</p></div></li>
          <li><span>2</span><div><strong>选择首次同步方式</strong><p>旧设备上传，新设备从云端恢复。</p></div></li>
          <li><span>3</span><div><strong>日常双向同步</strong><p>之后使用双向同步自动合并最新记录。</p></div></li>
        </ol>
        <div class="sync-auth-tabs" role="tablist" aria-label="云同步账号操作"><button :class="{ active: cloudAuthMode === 'sign-in' }" type="button" role="tab" :aria-selected="cloudAuthMode === 'sign-in'" @click="cloudAuthMode = 'sign-in'">登录</button><button :class="{ active: cloudAuthMode === 'sign-up' }" type="button" role="tab" :aria-selected="cloudAuthMode === 'sign-up'" @click="cloudAuthMode = 'sign-up'">注册新账号</button></div>
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
            :autocomplete="cloudAuthMode === 'sign-in' ? 'current-password' : 'new-password'"
          />
        </label>
        <label v-if="cloudAuthMode === 'sign-up'" class="setting-stack"><span>确认密码</span><input v-model="cloudPasswordConfirm" type="password" class="inline-input" autocomplete="new-password" /></label>
        <div class="actions">
          <button v-if="cloudAuthMode === 'sign-in'" class="btn btn-primary" :disabled="cloudBusy || !cloudEmail || !cloudPassword" @click="onCloudSignIn">登录云同步</button>
          <button v-else class="btn btn-primary" :disabled="cloudBusy || !cloudEmail || cloudPassword.length < 6 || !cloudPasswordConfirm" @click="onCloudSignUp">
            创建账号
          </button>
        </div>
        <p class="muted">密码至少 6 位。未登录时不会读取或写入云端，本地数据也不会被删除。</p>
      </div>

      <div v-else class="sync-panel">
        <ol class="sync-guide sync-guide-connected">
          <li><span>1</span><div><strong>首次使用</strong><p>旧设备选上传；新设备选恢复。</p></div></li>
          <li class="active"><span>2</span><div><strong>日常使用</strong><p>点击双向同步，自动保留两端较新的内容。</p></div></li>
        </ol>
        <button class="btn btn-primary sync-main-action" :disabled="cloudBusy" @click="onRunCloudSync('bidirectional')">立即双向同步</button>
        <button class="btn sync-preview-action" :disabled="cloudBusy" @click="onPreviewCloudSync('bidirectional')">先预览本次变化</button>

        <details class="sync-first-use-actions"><summary>首次同步与恢复选项</summary><div class="sync-choice-grid"><button class="btn" :disabled="cloudBusy" @click="onRunCloudSync('upload')"><strong>上传这台设备</strong><small>适合有完整数据的旧设备，并自动下载安全备份</small></button><button class="btn" :disabled="cloudBusy" @click="onRunCloudSync('download')"><strong>从云端恢复</strong><small>适合刚登录的新设备</small></button></div></details>

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
        <button class="btn btn-quiet sync-signout" :disabled="cloudBusy" @click="onCloudSignOut">退出云同步</button>
      </div>
    </article>
      </div>
    </details>

    <details id="settings-section-data" class="settings-group" :open="openSection === 'data'">
      <summary class="settings-group-summary" @click.prevent="selectSection('data', true)">
        <span class="settings-group-title"><span class="settings-group-icon"><DatabaseBackup :size="20" aria-hidden="true" /></span><span><strong>数据与关于</strong><small>备份、恢复与版本信息</small></span></span>
        <ChevronDown class="settings-group-chevron" :size="20" aria-hidden="true" />
      </summary>
      <div class="settings-group-content">
    <article class="result-section settings-card">
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

    <article v-if="!standalone" class="result-section settings-card install-app-card">
      <h2>添加到主屏幕</h2>
      <p class="muted">安装后可获得独立窗口、安全区适配和更稳定的离线启动体验。</p>
      <button class="btn" type="button" @click="onInstallApp">
        {{ canInstall ? '安装 WordsBook' : '查看安装方法' }}
      </button>
    </article>

    <footer class="settings-version muted" aria-label="应用版本">
      WordsBook Beta · v{{ appVersion }} · 更新于 {{ appUpdatedAt }}
    </footer>
      </div>
    </details>
  </section>
</template>
