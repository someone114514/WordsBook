import { describe, expect, it } from 'vitest'
import { createDeepseekRequest } from './deepseekRequest'

describe('DeepSeek request defaults', () => {
  it('uses the fast non-thinking mode for ordinary learning requests', () => {
    expect(createDeepseekRequest({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Create a short vocabulary exercise.' }],
    })).toMatchObject({
      model: 'deepseek-v4-flash',
      thinking: { type: 'disabled' },
    })
  })

  it('only enables high reasoning when a caller explicitly opts in', () => {
    expect(createDeepseekRequest({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Solve a difficult reasoning task.' }],
      thinking: true,
    })).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    })
  })
})
