import { describe, expect, it } from 'vitest'

import type { ModelInfo } from './api'
import { chooseModel, modelGroups, offeredNames } from './models'

const model = (name: string, vision: boolean | null): ModelInfo => ({
  name,
  size: null,
  parameter_size: null,
  family: null,
  vision,
  cloud: true,
})

const server = [model('gpt-oss:120b', false), model('qwen3-vl:235b', true), model('mystery:1b', null)]

describe('modelGroups', () => {
  it('offers vision models first and hides models that cannot read images', () => {
    const groups = modelGroups(server, [])

    expect(groups.vision.map((m) => m.name)).toEqual(['qwen3-vl:235b'])
    expect(groups.unknown.map((m) => m.name)).toEqual(['mystery:1b'])
    expect(offeredNames(groups)).toEqual(['qwen3-vl:235b', 'mystery:1b'])
  })

  it('adds models by name, once, trimmed, without repeating listed ones', () => {
    const groups = modelGroups(server, [' my-ocr:7b ', 'my-ocr:7b', '', 'qwen3-vl:235b'])

    expect(groups.added).toEqual(['my-ocr:7b'])
  })

  it('shows a model added by name even if the server says it cannot read images', () => {
    expect(modelGroups(server, ['gpt-oss:120b']).added).toEqual(['gpt-oss:120b'])
  })
})

describe('chooseModel', () => {
  const groups = modelGroups(server, ['my-ocr:7b'])

  it('keeps the model picked earlier while it is offered', () => {
    expect(chooseModel('my-ocr:7b', '', groups, true)).toBe('my-ocr:7b')
  })

  it('falls back to the configured default, then the first vision model', () => {
    expect(chooseModel('gone:1b', 'mystery:1b', groups, true)).toBe('mystery:1b')
    expect(chooseModel('gone:1b', '', groups, true)).toBe('qwen3-vl:235b')
    expect(chooseModel('', '', modelGroups([], []), true)).toBe('')
  })

  it('keeps the earlier pick while the server list is unknown', () => {
    expect(chooseModel('gone:1b', '', modelGroups([], []), false)).toBe('gone:1b')
  })
})
