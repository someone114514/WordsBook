export type LearningErrorArea = 'overview' | 'session' | 'ai-definition'

export function describeLearningError(reason: unknown, area: LearningErrorArea): string {
  if (area === 'overview') return '本地学习数据暂时无法读取，请重试。'
  if (area === 'session') return '本次学习操作未完成。进度已保留，请重试。'

  const detail = reason instanceof Error ? reason.message : String(reason ?? '')
  if (/\b401\b|unauthori[sz]ed|invalid.*(?:api[- ]?key|key)|api[- ]?key.*invalid/i.test(detail)) {
    return 'DeepSeek API Key 无效，请到设置中更新。'
  }
  if (/\b429\b|rate.?limit|too many requests/i.test(detail)) {
    return 'AI 请求过于频繁，请稍后重试。'
  }
  return 'AI 释义暂时无法更新，请稍后重试。'
}
