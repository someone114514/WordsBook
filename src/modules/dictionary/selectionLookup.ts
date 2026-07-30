const LOOKUP_TEXT_PATTERN = /^[A-Za-z](?:[A-Za-z'’ -]{0,78}[A-Za-z])?$/

export function normalizeLookupSelection(value: string): string {
  const normalized = value
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized || normalized.length > 80 || !LOOKUP_TEXT_PATTERN.test(normalized)) return ''
  return normalized
}

export function selectionElement(node: Node | null): Element | null {
  if (!node) return null
  return node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement
}

export function canLookupSelectionFrom(element: Element | null): boolean {
  if (!element || !element.closest('#app')) return false
  return !element.closest(
    'input, textarea, select, option, [contenteditable="true"], [data-selection-lookup="off"], .selection-lookup-panel',
  )
}
