import { afterEach, describe, expect, it } from 'vitest'
import { defaultUiLanguage, setUiLanguage, studyListName, t } from './index'
import english from './en.json'

afterEach(() => setUiLanguage('zh-CN'))

describe('interface language', () => {
  it('defaults GitHub Pages to English and preserves the local default', () => {
    expect(defaultUiLanguage('example.github.io')).toBe('en')
    expect(defaultUiLanguage('localhost')).toBe('zh-CN')
  })

  it('switches copy, interpolation, and the document language', () => {
    setUiLanguage('en')
    expect(t('第 {0} / {1} 题', [2, 6])).toBe('Question 2 of 6')
    expect(document.documentElement.lang).toBe('en')
    setUiLanguage('zh-CN')
    expect(t('第 {0} / {1} 题', [2, 6])).toBe('第 2 / 6 题')
    expect(document.documentElement.lang).toBe('zh-CN')
  })

  it('translates system lists while preserving user-created names', () => {
    setUiLanguage('en')
    expect(studyListName({ name: '我的单词', systemType: 'legacy' })).toBe('My words')
    expect(studyListName({ name: '我的单词' })).toBe('我的单词')
    expect(t('已创建「{0}」', ['旅行英语'])).toBe('Created “旅行英语”')
  })

  it('keeps every interpolation value in the English catalog', () => {
    for (const [source, translated] of Object.entries(english)) {
      expect(translated.match(/\{\d+\}/g)?.sort() ?? [], source)
        .toEqual(source.match(/\{\d+\}/g)?.sort() ?? [])
    }
  })
})
