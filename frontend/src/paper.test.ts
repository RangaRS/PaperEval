import { describe, expect, it } from 'vitest'

import type { PaperGroup, PaperNode, Question } from './api'
import { answerKeyFile, numberAfter, parseAnswerKey, partNumber, totals } from './exams'
import {
  buildPattern,
  flatPaper,
  groupKey,
  indentNode,
  maximum,
  moveNode,
  newGroup,
  normalize,
  outdentNode,
  questionKey,
  questionOrder,
  questionRef,
  ruleProblems,
  ruleText,
  tally,
  ungroup,
  wrapNode,
} from './paper'

const q = questionRef
const either = (...ids: string[]) => newGroup({ label: 'choice', rule: 'any', count: 1, children: ids.map(q) })
const score = (node: PaperNode, marks: Record<string, number>) => {
  const result = tally(node, (id) => marks[id] ?? 0)
  return [result.marks, result.counted]
}
const question = (id: string, max_marks: number): Question => ({
  id,
  number: id,
  question: '',
  answer: '',
  key: '',
  max_marks,
})

describe('tally', () => {
  it('counts the better of two choices once', () => {
    const paper = newGroup({ children: [q('1'), either('11a', '11b')] })

    expect(score(paper, { 1: 2, '11a': 6, '11b': 9 })).toEqual([11, ['1', '11b']])
    expect(maximum(paper, [question('1', 2), question('11a', 13), question('11b', 13)])).toBe(15)
  })

  it('prefers an answer the student wrote when choices score the same', () => {
    expect(tally(either('a', 'b'), () => 0, (id) => id === 'b').counted).toEqual(['b'])
  })

  it('counts the best N, taking at least some from each part', () => {
    const a = newGroup({ label: 'A', children: [q('a1'), q('a2'), q('a3')] })
    const b = newGroup({ label: 'B', children: [q('b1'), q('b2')] })
    const paper = newGroup({ rule: 'any', count: 3, min_each: 1, children: [a, b] })

    expect(score(paper, { a1: 9, a2: 8, a3: 7, b1: 1, b2: 2 })).toEqual([19, ['a1', 'a2', 'b2']])
  })

  it('caps the marks of a group', () => {
    expect(score(newGroup({ cap: 5, children: [q('a'), q('b')] }), { a: 4, b: 4 })[0]).toBe(5)
  })
})

describe('totals of an evaluation', () => {
  it('leave out the answers that do not count', () => {
    const answer = (id: string, marks: number) => ({
      question_id: id,
      number: id,
      max_marks: 13,
      answer: 'text',
      pages: [],
      status: 'graded' as const,
      ai_marks: marks,
      feedback: '',
      error: null,
      model: null,
      graded_at: null,
      teacher_marks: null,
      marks,
    })
    const result = totals([answer('a', 6), answer('b', 9)], newGroup({ rule: 'any', count: 1, children: [q('a'), q('b')] }))

    expect(result).toEqual({ marks: 9, max_marks: 13, complete: true, not_counted: ['a'] })
  })
})

describe('the rules in words', () => {
  it('describes each rule', () => {
    expect(ruleText(newGroup())).toBe('All count')
    expect(ruleText(either('a', 'b'))).toBe('Either / or')
    expect(ruleText(newGroup({ rule: 'any', count: 5, children: ['a', 'b', 'c', 'd', 'e', 'f'].map(q) }))).toBe(
      'Any 5 of 6',
    )
    expect(ruleText(newGroup({ cap: 50 }))).toBe('All count, up to 50 marks')
  })

  it('points out likely mistakes', () => {
    const tooMany = newGroup({ id: 'g1', rule: 'any', count: 3, children: [q('a'), q('b')] })
    const unequal = newGroup({ id: 'g2', rule: 'any', count: 1, children: [q('c'), q('d')] })
    const problems = ruleProblems(newGroup({ children: [tooMany, unequal] }), [
      question('a', 1),
      question('b', 1),
      question('c', 16),
      question('d', 12),
    ])

    expect(problems.get('g1')).toBe('Counts 3, but there are only 2 to choose from.')
    expect(problems.get('g2')).toBe('The choices are not worth the same marks.')
  })
})

describe('editing the tree', () => {
  const paper = (): PaperGroup =>
    normalize(newGroup({ children: [q('1'), newGroup({ id: 'g', children: [q('2')] }), q('3')] }), ['1', '2', '3'])

  it('keeps every question once', () => {
    expect(questionOrder(normalize(newGroup({ children: [q('1'), q('1'), q('x')] }), ['1', '2']))).toEqual(['1', '2'])
  })

  it('moves, indents and outdents', () => {
    expect(questionOrder(moveNode(paper(), questionKey('3'), -1))).toEqual(['1', '3', '2'])
    const indented = indentNode(paper(), questionKey('3'))
    expect(questionOrder(indented)).toEqual(['1', '2', '3'])
    expect((indented.children[1] as PaperGroup).children).toHaveLength(2)
    const outdented = outdentNode(paper(), questionKey('2'))
    expect(outdented.children.map((child) => child.kind)).toEqual(['question', 'group', 'question', 'question'])
  })

  it('wraps a question into a choice, and ungroups', () => {
    const wrapped = wrapNode(paper(), questionKey('1'), either(), [q('1b')])
    const choice = wrapped.children[0] as PaperGroup
    expect(choice.rule).toBe('any')
    expect(questionOrder(choice)).toEqual(['1', '1b'])
    expect(ungroup(wrapped, choice.id).children[0]).toEqual(q('1'))
    expect(ungroup(paper(), 'g').children).toEqual([q('1'), q('2'), q('3')])
    expect(groupKey('g')).toBe('g:g')
  })
})

describe('numbering', () => {
  it('names parts and the labels after them', () => {
    expect(partNumber('11', 0)).toBe('11 (a)')
    expect(partNumber('11 (a)', 1)).toBe('11 (a) (ii)')
    expect(numberAfter('11 (a)')).toBe('11 (b)')
    expect(numberAfter('11 (a) (i)')).toBe('11 (a) (ii)')
    expect(numberAfter('Part B 9')).toBe('Part B 10')
  })
})

describe('patterns', () => {
  it('makes either/or pairs in a section', () => {
    const { questions, nodes } = buildPattern({
      kind: 'pairs',
      count: 2,
      choose: 1,
      marks: 13,
      start: '11',
      section: 'Part B',
    })

    expect(questions.map((item) => item.number)).toEqual(['11 (a)', '11 (b)', '12 (a)', '12 (b)'])
    const [section] = nodes as PaperGroup[]
    expect(section.label).toBe('Part B')
    expect(maximum(section, questions)).toBe(26)
  })

  it('makes "any 5 of 8"', () => {
    const { questions, nodes } = buildPattern({ kind: 'any', count: 8, choose: 5, marks: 10, start: '1', section: '' })

    expect(questions).toHaveLength(8)
    expect(maximum(nodes[0], questions)).toBe(50)
  })
})

describe('key files', () => {
  it('keep sections and choices when saved and read back', () => {
    const questions = [question('1', 2), question('11a', 13), question('11b', 13)]
    const structure = normalize(
      newGroup({ children: [q('1'), newGroup({ label: '11', rule: 'any', count: 1, children: [q('11a'), q('11b')] })] }),
      questions.map((item) => item.id),
    )

    const parsed = parseAnswerKey(JSON.stringify(answerKeyFile({ name: 'Paper', questions, structure })), 'file')

    expect(parsed.questions.map((item) => item.number)).toEqual(['1', '11a', '11b'])
    expect(maximum(parsed.structure, parsed.questions)).toBe(15)
    expect(ruleText(parsed.structure.children[1] as PaperGroup)).toBe('Either / or')
    expect(flatPaper([]).children).toEqual([])
  })
})
