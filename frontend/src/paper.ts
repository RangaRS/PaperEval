/**
 * How a question paper is laid out, and how its totals follow from that.
 *
 * A paper is a tree of groups whose leaves are the questions. Each group has a
 * rule saying which of its children count: all of them, or the best `count`
 * (with "either/or" being any 1 of 2). With `min_each`, the children of each
 * child group are pooled and at least that many must come from each, as in
 * "answer any six, at least two from each part". A group may also cap its marks.
 *
 * `backend/app/paper.py` works the totals out the same way; keep the two in step.
 */
import type { PaperGroup, PaperNode, Question } from './api'
import { formatMarks, newQuestionId, numberAfter, partNumber } from './exams'

export const ROOT_ID = 'root'

export const newGroupId = () => `g${newQuestionId()}`

export function newGroup(changes: Partial<PaperGroup> = {}): PaperGroup {
  return { kind: 'group', id: newGroupId(), label: '', text: '', rule: 'all', count: 1, min_each: 0, cap: 0, children: [], ...changes }
}

export const questionRef = (questionId: string): PaperNode => ({ kind: 'question', question_id: questionId })

/** A paper where every question counts. */
export const flatPaper = (questions: { id: string }[]): PaperGroup =>
  newGroup({ id: ROOT_ID, children: questions.map((question) => questionRef(question.id)) })

/** The paper with every question in it exactly once: unknown or repeated questions dropped, missing ones added at the end. */
export function normalize(structure: PaperGroup | null | undefined, questionIds: string[]): PaperGroup {
  if (!structure) return flatPaper(questionIds.map((id) => ({ id })))
  const known = new Set(questionIds)
  const placed = new Set<string>()
  const clean = (group: PaperGroup): PaperGroup => ({
    ...group,
    children: group.children.flatMap((child): PaperNode[] => {
      if (child.kind === 'group') return [clean(child)]
      if (!known.has(child.question_id) || placed.has(child.question_id)) return []
      placed.add(child.question_id)
      return [child]
    }),
  })
  const root = clean({ ...structure, id: ROOT_ID })
  const missing = questionIds.filter((id) => !placed.has(id)).map(questionRef)
  return missing.length > 0 ? { ...root, children: [...root.children, ...missing] } : root
}

/** The questions' ids in paper order. */
export function questionOrder(node: PaperNode): string[] {
  return node.kind === 'question' ? [node.question_id] : node.children.flatMap(questionOrder)
}

export interface Tally {
  marks: number
  /** The questions whose marks count. */
  counted: string[]
  attempted: boolean
}

/** The marks a node gives, and which questions they come from, given each question's marks. */
export function tally(
  node: PaperNode,
  marks: (questionId: string) => number,
  attempted: (questionId: string) => boolean = () => true,
): Tally {
  if (node.kind === 'question') {
    return { marks: marks(node.question_id), counted: [node.question_id], attempted: attempted(node.question_id) }
  }
  let parts: Tally[]
  let chosen: Tally[]
  if (node.rule === 'all') {
    parts = node.children.map((child) => tally(child, marks, attempted))
    chosen = parts
  } else {
    const candidates = node.children.flatMap<{ part: number | null; node: PaperNode }>((child, index) =>
      node.min_each > 0 && child.kind === 'group'
        ? child.children.map((grandchild) => ({ part: index, node: grandchild }))
        : [{ part: null, node: child }],
    )
    parts = candidates.map((candidate) => tally(candidate.node, marks, attempted))
    // Best first; among equals, one the student attempted, then the earlier one.
    const ranked = parts
      .map((_, index) => index)
      .sort(
        (a, b) =>
          parts[b].marks - parts[a].marks || Number(parts[b].attempted) - Number(parts[a].attempted) || a - b,
      )
    const picked: number[] = []
    if (node.min_each > 0) {
      const partIndexes = [...new Set(candidates.flatMap((candidate) => (candidate.part === null ? [] : [candidate.part])))]
      for (const part of partIndexes.sort((a, b) => a - b)) {
        picked.push(...ranked.filter((index) => candidates[index].part === part).slice(0, node.min_each))
      }
    }
    for (const index of ranked) {
      if (picked.length >= node.count) break
      if (!picked.includes(index)) picked.push(index)
    }
    chosen = picked.sort((a, b) => a - b).map((index) => parts[index])
  }
  let total = chosen.reduce((sum, part) => sum + part.marks, 0)
  if (node.cap > 0) total = Math.min(total, node.cap)
  return {
    marks: total,
    counted: chosen.flatMap((part) => part.counted),
    attempted: parts.some((part) => part.attempted),
  }
}

/** The most marks a node can give. */
export function maximum(node: PaperNode, questions: { id: string; max_marks: number }[]): number {
  const marks = new Map(questions.map((question) => [question.id, question.max_marks]))
  return tally(node, (id) => marks.get(id) ?? 0).marks
}

/** How many candidates an "any" group chooses from. */
export function poolSize(group: PaperGroup): number {
  return group.min_each > 0
    ? group.children.reduce((total, child) => total + (child.kind === 'group' ? child.children.length : 1), 0)
    : group.children.length
}

/** The rule in words: "All count", "Either / or", "Any 5 of 8, at least 1 from each part". */
export function ruleText(group: PaperGroup): string {
  let text: string
  if (group.rule === 'all') text = 'All count'
  else if (group.count === 1 && poolSize(group) === 2 && group.min_each === 0) text = 'Either / or'
  else text = `Any ${group.count} of ${poolSize(group)}`
  if (group.rule === 'any' && group.min_each > 0) text += `, at least ${group.min_each} from each part`
  if (group.cap > 0) text += `, up to ${formatMarks(group.cap)} marks`
  return text
}

/** Things in the rules that look like mistakes, in words, by group id. */
export function ruleProblems(structure: PaperGroup, questions: Question[]): Map<string, string> {
  const problems = new Map<string, string>()
  const walk = (group: PaperGroup) => {
    if (group.rule === 'any') {
      const pool = poolSize(group)
      const parts = group.children.filter((child) => child.kind === 'group').length
      const options = group.min_each === 0 ? new Set(group.children.map((child) => maximum(child, questions))) : new Set()
      if (group.count > pool) problems.set(group.id, `Counts ${group.count}, but there are only ${pool} to choose from.`)
      else if (group.min_each > 0 && parts === 0) problems.set(group.id, 'Has no parts to take at least one from.')
      else if (group.min_each * parts > group.count)
        problems.set(group.id, `Needs ${group.min_each} from each of ${parts} parts, more than the ${group.count} that count.`)
      else if (options.size > 1) problems.set(group.id, 'The choices are not worth the same marks.')
    }
    for (const child of group.children) if (child.kind === 'group') walk(child)
  }
  walk(structure)
  return problems
}

// Changes to the tree, for the editor. Each returns a new tree.

/** The tree with a group changed. */
export function updateGroup(root: PaperGroup, id: string, change: (group: PaperGroup) => PaperGroup): PaperGroup {
  const visit = (group: PaperGroup): PaperGroup => {
    if (group.id === id) return change(group)
    return { ...group, children: group.children.map((child) => (child.kind === 'group' ? visit(child) : child)) }
  }
  return visit(root)
}

const nodeKey = (node: PaperNode) => (node.kind === 'group' ? `g:${node.id}` : `q:${node.question_id}`)
export const groupKey = (id: string) => `g:${id}`
export const questionKey = (id: string) => `q:${id}`

/** Where a node is: its parent group and its index there. */
export function locate(root: PaperGroup, key: string): { parent: PaperGroup; index: number } | null {
  for (const [index, child] of root.children.entries()) {
    if (nodeKey(child) === key) return { parent: root, index }
    if (child.kind === 'group') {
      const found = locate(child, key)
      if (found) return found
    }
  }
  return null
}

const replaceChildren = (root: PaperGroup, parentId: string, change: (children: PaperNode[]) => PaperNode[]) =>
  updateGroup(root, parentId, (group) => ({ ...group, children: change(group.children) }))

/** Move a node up or down among its siblings. */
export function moveNode(root: PaperGroup, key: string, offset: number): PaperGroup {
  const where = locate(root, key)
  if (!where) return root
  const target = where.index + offset
  if (target < 0 || target >= where.parent.children.length) return root
  return replaceChildren(root, where.parent.id, (children) => {
    const next = [...children]
    const [node] = next.splice(where.index, 1)
    next.splice(target, 0, node)
    return next
  })
}

/** Put a node into the group just above it, at the end. */
export function indentNode(root: PaperGroup, key: string): PaperGroup {
  const where = locate(root, key)
  const above = where && where.index > 0 ? where.parent.children[where.index - 1] : undefined
  if (!where || above?.kind !== 'group') return root
  const node = where.parent.children[where.index]
  return replaceChildren(root, where.parent.id, (children) =>
    children.flatMap((child, index) =>
      index === where.index ? [] : index === where.index - 1 ? [{ ...above, children: [...above.children, node] }] : [child],
    ),
  )
}

/** Take a node out of its group, placing it just after the group. */
export function outdentNode(root: PaperGroup, key: string): PaperGroup {
  const where = locate(root, key)
  if (!where || where.parent.id === ROOT_ID) return root
  const outer = locate(root, groupKey(where.parent.id))
  if (!outer) return root
  const node = where.parent.children[where.index]
  const without = replaceChildren(root, where.parent.id, (children) => children.filter((_, index) => index !== where.index))
  return replaceChildren(without, outer.parent.id, (children) => [
    ...children.slice(0, outer.index + 1),
    node,
    ...children.slice(outer.index + 1),
  ])
}

/** Insert nodes after the node with the key, or at the end of the group with the id when `key` is a group's own id. */
export function insertAfter(root: PaperGroup, key: string, nodes: PaperNode[]): PaperGroup {
  const where = locate(root, key)
  if (!where) return { ...root, children: [...root.children, ...nodes] }
  return replaceChildren(root, where.parent.id, (children) => [
    ...children.slice(0, where.index + 1),
    ...nodes,
    ...children.slice(where.index + 1),
  ])
}

/** Replace a node with a group holding it and the given nodes. */
export function wrapNode(root: PaperGroup, key: string, group: PaperGroup, after: PaperNode[]): PaperGroup {
  const where = locate(root, key)
  if (!where) return root
  const node = where.parent.children[where.index]
  return replaceChildren(root, where.parent.id, (children) =>
    children.map((child, index) => (index === where.index ? { ...group, children: [node, ...after] } : child)),
  )
}

/** Remove a group, keeping its children in its place. */
export function ungroup(root: PaperGroup, id: string): PaperGroup {
  const where = locate(root, groupKey(id))
  if (!where) return root
  const group = where.parent.children[where.index] as PaperGroup
  return replaceChildren(root, where.parent.id, (children) =>
    children.flatMap((child, index) => (index === where.index ? group.children : [child])),
  )
}

/** Remove a question from the tree. */
export function removeQuestion(root: PaperGroup, questionId: string): PaperGroup {
  const where = locate(root, questionKey(questionId))
  if (!where) return root
  return replaceChildren(root, where.parent.id, (children) => children.filter((_, index) => index !== where.index))
}

export type PatternKind = 'compulsory' | 'pairs' | 'any'

export interface Pattern {
  kind: PatternKind
  /** How many questions, or pairs of questions. */
  count: number
  /** For "any": how many of them count. */
  choose: number
  marks: number
  /** The first question's number, e.g. "11". */
  start: string
  /** The section's name, e.g. "Part B"; empty for none. */
  section: string
}

/** The questions and paper layout a pattern makes, such as "5 either/or pairs of 13 marks" in "Part B". */
export function buildPattern(pattern: Pattern): { questions: Question[]; nodes: PaperNode[] } {
  const questions: Question[] = []
  const add = (number: string): PaperNode => {
    const question: Question = { id: newQuestionId(), number, question: '', answer: '', key: '', max_marks: pattern.marks }
    questions.push(question)
    return questionRef(question.id)
  }
  const numbers: string[] = []
  for (let index = 0; index < pattern.count; index++) {
    numbers.push(index === 0 ? pattern.start : numberAfter(numbers[index - 1]) || '')
  }
  const items: PaperNode[] =
    pattern.kind === 'pairs'
      ? numbers.map((number) =>
          newGroup({ label: number, rule: 'any', count: 1, children: [add(partNumber(number, 0)), add(partNumber(number, 1))] }),
        )
      : numbers.map(add)
  const rule =
    pattern.kind === 'any' ? { rule: 'any' as const, count: Math.max(1, Math.min(pattern.choose, pattern.count)) } : {}
  if (!pattern.section.trim() && pattern.kind !== 'any') return { questions, nodes: items }
  return { questions, nodes: [newGroup({ label: pattern.section.trim(), ...rule, children: items })] }
}
