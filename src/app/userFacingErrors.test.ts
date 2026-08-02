import { describe, expect, it } from 'vitest'
import { describeLearningError } from './userFacingErrors'

describe('learning user-facing errors', () => {
  it('never exposes storage or runtime details on learning screens', () => {
    const reason = new Error('import function env:napi_create_async_work WASM stack sentinel')
    expect(describeLearningError(reason, 'overview')).toBe('本地学习数据暂时无法读取，请重试。')
    expect(describeLearningError(reason, 'session')).toBe('本次学习操作未完成。进度已保留，请重试。')
    expect(describeLearningError(reason, 'ai-definition')).toBe('AI 释义暂时无法更新，请稍后重试。')
  })

  it('keeps only actionable AI failure categories', () => {
    expect(describeLearningError(new Error('HTTP 401 Unauthorized'), 'ai-definition')).toContain('API Key 无效')
    expect(describeLearningError(new Error('HTTP 429 Too Many Requests'), 'ai-definition')).toContain('请求过于频繁')
  })
})
