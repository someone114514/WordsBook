import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import GlobalSelectionLookup from './GlobalSelectionLookup.vue'

const mocks = vi.hoisted(() => ({
  lookupWord: vi.fn(),
  addEntryToStudyList: vi.fn(),
}))

vi.mock('../modules/dictionary/dictionaryService', () => ({ lookupWord: mocks.lookupWord }))
vi.mock('../modules/dictionary/audioService', () => ({
  playEntryPronunciation: vi.fn(async () => ({ success: true, source: 'tts' })),
}))
vi.mock('../modules/settings/settingsService', () => ({
  loadSettings: vi.fn(async () => ({
    definitionLanguage: 'adaptive',
    articleLevel: 'B2',
  })),
}))
vi.mock('../modules/wordbook/studyListService', () => ({
  LOOKUP_LIST_ID: 'system:lookup',
  listStudyLists: vi.fn(async () => [{
    listId: 'list:1',
    name: '测试词表',
    studyEnabled: 1,
    wordCount: 0,
    activeWordCount: 0,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
  }]),
  addEntryToStudyList: mocks.addEntryToStudyList,
}))

describe('GlobalSelectionLookup', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.lookupWord.mockResolvedValue({
      query: 'meticulous',
      normalizedQuery: 'meticulous',
      exactMatches: [{
        entryId: 'entry:meticulous',
        headword: 'meticulous',
        headwordLower: 'meticulous',
        posList: ['adj'],
        sensesJson: '[]',
        examplesJson: '[]',
        usageJson: '[]',
        senseRecordsJson: JSON.stringify([{
          senseId: 'meticulous:1',
          definitionEn: 'showing great attention to detail',
          glossZh: '一丝不苟的',
          examples: [],
        }]),
      }],
      lemmaMatches: [],
      prefixMatches: [],
      fuzzyMatches: [],
      hasResult: true,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  it('keeps the panel open when its own interaction collapses the native text selection', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/review/session', component: { template: '<div />' } },
        { path: '/lookup', component: { template: '<div />' } },
      ],
    })
    await router.push('/review/session')
    await router.isReady()
    const host = document.createElement('div')
    host.id = 'app'
    host.innerHTML = '<p id="source">meticulous</p>'
    document.body.append(host)
    const source = host.querySelector('#source')!
    const wrapper = mount(GlobalSelectionLookup, {
      attachTo: host,
      global: { plugins: [router] },
    })
    await flushPromises()

    const range = document.createRange()
    range.selectNodeContents(source)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    await vi.advanceTimersByTimeAsync(200)
    await flushPromises()
    expect(document.querySelector('.selection-lookup-panel')).not.toBeNull()

    const chooseList = [...document.querySelectorAll<HTMLButtonElement>('.selection-lookup-panel button')]
      .find((button) => button.textContent?.includes('选择词表'))!
    chooseList.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    window.getSelection()!.removeAllRanges()
    document.dispatchEvent(new Event('selectionchange'))
    chooseList.click()
    await vi.advanceTimersByTimeAsync(200)
    await flushPromises()
    expect(document.querySelector('.selection-list-picker')).not.toBeNull()

    await vi.advanceTimersByTimeAsync(600)
    document.dispatchEvent(new Event('selectionchange'))
    await vi.advanceTimersByTimeAsync(200)
    await flushPromises()
    expect(document.querySelector('.selection-lookup-panel')).toBeNull()
    wrapper.unmount()
  })
})
