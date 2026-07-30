import { describe, expect, it } from 'vitest'
import {
  canLookupSelectionFrom,
  normalizeLookupSelection,
  selectionElement,
} from './selectionLookup'

describe('global selection lookup', () => {
  it('normalizes English words and short phrases without accepting arbitrary UI text', () => {
    expect(normalizeLookupSelection('  state   of mind ')).toBe('state of mind')
    expect(normalizeLookupSelection('learner’s')).toBe("learner's")
    expect(normalizeLookupSelection('aperture.')).toBe('')
    expect(normalizeLookupSelection('查看中文')).toBe('')
  })

  it('allows real app text including button choices but excludes form input and lookup panel text', () => {
    document.body.innerHTML = `
      <div id="app">
        <button id="choice"><span>resilient</span></button>
        <input id="query" value="resilient">
        <aside class="selection-lookup-panel"><span id="panel-word">resilient</span></aside>
      </div>
    `
    expect(canLookupSelectionFrom(document.querySelector('#choice span'))).toBe(true)
    expect(canLookupSelectionFrom(document.querySelector('#query'))).toBe(false)
    expect(canLookupSelectionFrom(document.querySelector('#panel-word'))).toBe(false)
  })

  it('resolves text nodes to their containing element', () => {
    const element = document.createElement('p')
    element.textContent = 'vivid'
    expect(selectionElement(element.firstChild)).toBe(element)
  })
})
