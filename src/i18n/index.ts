import { readonly, ref } from 'vue'
import english from './en.json'
import type { StudyList } from '../types/models'

export type UiLanguage = 'en' | 'zh-CN'

export function defaultUiLanguage(hostname: string): UiLanguage {
  return hostname.endsWith('.github.io') ? 'en' : 'zh-CN'
}

export const DEFAULT_UI_LANGUAGE = defaultUiLanguage(globalThis.location?.hostname ?? '')
const currentLanguage = ref<UiLanguage>(DEFAULT_UI_LANGUAGE)
export const uiLanguage = readonly(currentLanguage)

export function setUiLanguage(language: UiLanguage): void {
  currentLanguage.value = language
  if (typeof document !== 'undefined') document.documentElement.lang = language
}

/** Translate interface copy only; dictionary and user content keep their original language. */
export function t(source: string, values: readonly unknown[] = []): string {
  const message = currentLanguage.value === 'en'
    ? (english as Record<string, string>)[source] ?? source
    : source
  return message.replace(/\{(\d+)\}/g, (placeholder, index: string) =>
    Number(index) < values.length ? String(values[Number(index)] ?? '') : placeholder)
}

export function studyListName(list: Pick<StudyList, 'name' | 'systemType'> & { listId?: string }): string {
  if (list.systemType === 'lookup' || list.listId === 'system:lookup') return t('仅保存')
  if (list.systemType === 'legacy' || list.listId === 'system:legacy') return t('我的单词')
  return list.name
}
