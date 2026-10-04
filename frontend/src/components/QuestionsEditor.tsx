import {
  ArrowDown,
  ArrowUp,
  IndentDecrease,
  IndentIncrease,
  LayoutList,
  ListPlus,
  Plus,
  Sigma,
  Split,
  Trash2,
  TriangleAlert,
  Ungroup,
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'

import type { PaperGroup, PaperNode, Question } from '../api'
import { blankQuestion, formatMarks, nextTopNumber, numberAfter, partNumber, questionLabel } from '../exams'
import { isBoolean, useLocalStorage } from '../hooks'
import {
  buildPattern,
  groupKey,
  indentNode,
  insertAfter,
  locate,
  maximum,
  moveNode,
  newGroup,
  normalize,
  outdentNode,
  type Pattern,
  questionKey,
  questionOrder,
  questionRef,
  removeQuestion,
  ROOT_ID,
  ruleProblems,
  ruleText,
  ungroup,
  updateGroup,
  wrapNode,
} from '../paper'
import { NumberField } from './NumberField'
import { RichText } from './RichText'

export interface Paper {
  questions: Question[]
  structure: PaperGroup
}

/** The paper with its questions listed in the order they appear in it. */
function arranged(questions: Question[], structure: PaperGroup): Paper {
  const clean = normalize(
    structure,
    questions.map((question) => question.id),
  )
  const byId = new Map(questions.map((question) => [question.id, question]))
  return { questions: questionOrder(clean).flatMap((id) => byId.get(id) ?? []), structure: clean }
}

/**
 * The questions of an evaluator laid out as on the paper: sections, questions with sub-parts and choices, each
 * group with a rule saying which of its parts count, and each question with its model answer, marking key and marks.
 */
export function QuestionsEditor({
  questions,
  structure,
  onChange,
}: Paper & {
  onChange: (paper: Paper) => void
}) {
  const [preview, setPreview] = useLocalStorage('papereval.keyPreview', false, isBoolean)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [patternOpen, setPatternOpen] = useState(false)
  const byId = new Map(questions.map((question) => [question.id, question]))
  const problems = ruleProblems(structure, questions)

  const commit = (nextQuestions: Question[], nextStructure: PaperGroup) => onChange(arranged(nextQuestions, nextStructure))
  const setStructure = (next: PaperGroup) => commit(questions, next)
  const change = (id: string, changes: Partial<Question>) =>
    commit(
      questions.map((question) => (question.id === id ? { ...question, ...changes } : question)),
      structure,
    )
  const renamed = (renames: Map<string, string>) =>
    questions.map((question) => (renames.has(question.id) ? { ...question, number: renames.get(question.id)! } : question))
  const blank = (number: string, max_marks = 0): Question => ({ ...blankQuestion([]), number, max_marks })

  /** The labels of the questions and groups inside a group, in order. */
  const labels = (group: PaperGroup) =>
    group.children.map((child) => (child.kind === 'group' ? child.label : (byId.get(child.question_id)?.number ?? '')))
  const nodeLabel = (node: PaperNode) =>
    node.kind === 'group' ? node.label : (byId.get(node.question_id)?.number ?? '')

  const removeOne = (question: Question) => {
    const hasContent = question.question || question.answer || question.key
    if (hasContent && !window.confirm(`Remove ${questionLabel(question.number, 0)}?`)) return
    commit(
      questions.filter((candidate) => candidate.id !== question.id),
      removeQuestion(structure, question.id),
    )
  }
  const removeGroup = (group: PaperGroup) => {
    const ids = new Set(questionOrder(group))
    const name = group.label || 'this group'
    if (ids.size > 0 && !window.confirm(`Remove ${name} and its ${ids.size === 1 ? 'question' : `${ids.size} questions`}?`))
      return
    const where = locate(structure, groupKey(group.id))
    if (!where) return
    commit(
      questions.filter((question) => !ids.has(question.id)),
      updateGroup(structure, where.parent.id, (parent) => ({
        ...parent,
        children: parent.children.filter((_, index) => index !== where.index),
      })),
    )
  }

  /** Add a question at the end of a group. */
  const addInto = (group: PaperGroup) => {
    const inside = labels(group).filter(Boolean)
    const number =
      group.id === ROOT_ID ? nextTopNumber(questions) : inside.length > 0 ? numberAfter(inside.at(-1)!) : partNumber(group.label, 0)
    const question = blank(number)
    commit([...questions, question], updateGroup(structure, group.id, (g) => ({ ...g, children: [...g.children, questionRef(question.id)] })))
    setFocusId(question.id)
  }

  /**
   * Give a question or group a part after it: a sub-part ("11" becomes "11 (a)" and "11 (b)"), or an OR option
   * ("11 (a) OR 11 (b)"). Inside a group of that kind, the new part simply goes after it.
   */
  const addPart = (key: string, choice: boolean) => {
    const where = locate(structure, key)
    if (!where) return
    const node = where.parent.children[where.index]
    const parent = where.parent
    const base = nodeLabel(node)
    // A part of a question numbered after it, like "11 (b)" in "11".
    const ownPart = parent.label !== '' && base.startsWith(parent.label) && base !== parent.label
    const sameKind = choice
      ? parent.rule === 'any' && parent.count === 1 && parent.min_each === 0
      : parent.rule === 'all' && ownPart
    if (parent.id !== ROOT_ID && sameKind) {
      const last = labels(parent).filter(Boolean).at(-1) ?? ''
      // An option is usually worth what the other options are.
      const question = blank(last ? numberAfter(last) : '', choice ? maximum(node, questions) : 0)
      commit([...questions, question], insertAfter(structure, nodeKey(parent.children.at(-1)!), [questionRef(question.id)]))
      setFocusId(question.id)
      return
    }
    const renames = new Map<string, string>()
    let next = structure
    if (node.kind === 'question') renames.set(node.question_id, partNumber(base, 0))
    else next = updateGroup(next, node.id, (group) => ({ ...group, label: partNumber(base, 0) }))
    const question = blank(partNumber(base, 1), choice ? maximum(node, questions) : 0)
    const group = newGroup({ label: base, rule: choice ? 'any' : 'all', count: 1 })
    commit([...renamed(renames), question], wrapNode(next, key, group, [questionRef(question.id)]))
    setFocusId(question.id)
  }

  const addSection = () => {
    const section = newGroup({ label: nextSectionName(structure) })
    const question = blank(nextTopNumber(questions))
    commit([...questions, question], { ...structure, children: [...structure.children, { ...section, children: [questionRef(question.id)] }] })
    setFocusId(question.id)
  }

  const renderNodes = (group: PaperGroup, depth: number) => (
    <ol className={depth === 0 ? 'question-list' : 'question-list group-children'}>
      {group.children.map((node, index) => {
        const key = nodeKey(node)
        const above = index > 0 ? group.children[index - 1] : undefined
        const position = {
          first: index === 0,
          last: index === group.children.length - 1,
          canIndent: above?.kind === 'group',
          canOutdent: group.id !== ROOT_ID,
          inChoice: group.rule === 'any',
        }
        const moves = {
          onMove: (offset: number) => setStructure(moveNode(structure, key, offset)),
          onIndent: () => setStructure(indentNode(structure, key)),
          onOutdent: () => setStructure(outdentNode(structure, key)),
          onAddPart: () => addPart(key, false),
          onAddOption: () => addPart(key, true),
        }
        if (node.kind === 'group') {
          return (
            <li key={key}>
              <GroupCard
                group={node}
                maximum={maximum(node, questions)}
                problem={problems.get(node.id)}
                preview={preview}
                {...position}
                {...moves}
                onChange={(changes) => setStructure(updateGroup(structure, node.id, (current) => ({ ...current, ...changes })))}
                onUngroup={() => setStructure(ungroup(structure, node.id))}
                onRemove={() => removeGroup(node)}
                onAddQuestion={() => addInto(node)}
              >
                {renderNodes(node, depth + 1)}
              </GroupCard>
            </li>
          )
        }
        const question = byId.get(node.question_id)
        if (!question) return null
        return (
          <li key={key}>
            <QuestionCard
              question={question}
              index={questions.indexOf(question)}
              preview={preview}
              autoFocus={question.id === focusId}
              {...position}
              {...moves}
              onChange={(changes) => change(question.id, changes)}
              onRemove={() => removeOne(question)}
            />
          </li>
        )
      })}
    </ol>
  )

  return (
    <>
      {questions.length > 0 && (
        <div className="exam-toolbar">
          <div className="segmented segmented-small" role="group" aria-label="Show the questions">
            <button
              type="button"
              className={!preview ? 'is-active' : undefined}
              aria-pressed={!preview}
              onClick={() => setPreview(false)}
            >
              Edit
            </button>
            <button
              type="button"
              className={preview ? 'is-active' : undefined}
              aria-pressed={preview}
              onClick={() => setPreview(true)}
            >
              <Sigma size={13} aria-hidden />
              Preview
            </button>
          </div>
          <span className="hint">
            Write maths in LaTeX, like <code>$\frac{'{a}{b}'}$</code>. Ctrl+S saves.
          </span>
        </div>
      )}
      {renderNodes(structure, 0)}
      <div className="paper-add">
        <button type="button" className="btn add-question" onClick={() => addInto(structure)}>
          <Plus size={15} aria-hidden />
          Add a question
        </button>
        <button type="button" className="btn add-question" onClick={addSection}>
          <LayoutList size={15} aria-hidden />
          Add a section
        </button>
        <button type="button" className="btn add-question" onClick={() => setPatternOpen((open) => !open)} aria-expanded={patternOpen}>
          <ListPlus size={15} aria-hidden />
          Add from a pattern
        </button>
      </div>
      {patternOpen && (
        <PatternForm
          defaultNumber={nextTopNumber(questions) || '1'}
          defaultSection={nextSectionName(structure)}
          onCancel={() => setPatternOpen(false)}
          onAdd={(pattern) => {
            const built = buildPattern(pattern)
            commit([...questions, ...built.questions], { ...structure, children: [...structure.children, ...built.nodes] })
            setPatternOpen(false)
          }}
        />
      )}
    </>
  )
}

const nodeKey = (node: PaperNode) => (node.kind === 'group' ? groupKey(node.id) : questionKey(node.question_id))

/** "Part A" for the first section, then "Part B", and so on. */
function nextSectionName(structure: PaperGroup): string {
  const sections = structure.children.filter((child) => child.kind === 'group' && /^part\s+[a-z]$/i.test(child.label))
  return `Part ${String.fromCharCode(65 + Math.min(sections.length, 25))}`
}

interface Position {
  first: boolean
  last: boolean
  canIndent: boolean
  canOutdent: boolean
  /** Whether it is one of the choices of a group. */
  inChoice: boolean
}

interface Moves {
  onMove: (offset: number) => void
  onIndent: () => void
  onOutdent: () => void
  onAddPart: () => void
  onAddOption: () => void
}

/** The buttons to move a question or group, and to give it parts or an OR option. */
function NodeActions({
  label,
  first,
  last,
  canIndent,
  canOutdent,
  onMove,
  onIndent,
  onOutdent,
  onAddPart,
  onAddOption,
  children,
}: Position & Moves & { label: string; children?: ReactNode }) {
  return (
    <div className="question-card-actions">
      <button type="button" className="btn btn-small" onClick={onAddPart} title="Give it a sub-part that must also be answered">
        <Plus size={13} aria-hidden />
        Sub-part
      </button>
      <button type="button" className="btn btn-small" onClick={onAddOption} title="Give it an alternative: answer this OR that">
        <Split size={13} aria-hidden />
        OR option
      </button>
      <button type="button" className="icon-btn" onClick={() => onMove(-1)} disabled={first} title="Move up" aria-label={`Move ${label} up`}>
        <ArrowUp size={15} />
      </button>
      <button type="button" className="icon-btn" onClick={() => onMove(1)} disabled={last} title="Move down" aria-label={`Move ${label} down`}>
        <ArrowDown size={15} />
      </button>
      <button
        type="button"
        className="icon-btn"
        onClick={onIndent}
        disabled={!canIndent}
        title="Move into the group above"
        aria-label={`Move ${label} into the group above`}
      >
        <IndentIncrease size={15} />
      </button>
      <button
        type="button"
        className="icon-btn"
        onClick={onOutdent}
        disabled={!canOutdent}
        title="Move out of its group"
        aria-label={`Move ${label} out of its group`}
      >
        <IndentDecrease size={15} />
      </button>
      {children}
    </div>
  )
}

/** The choice of rule for a group, in plain words. */
type RuleChoice = 'all' | 'either' | 'any'

function GroupCard({
  group,
  maximum,
  problem,
  preview,
  onChange,
  onUngroup,
  onRemove,
  onAddQuestion,
  children,
  ...rest
}: Position &
  Moves & {
    group: PaperGroup
    maximum: number
    problem: string | undefined
    preview: boolean
    onChange: (changes: Partial<PaperGroup>) => void
    onUngroup: () => void
    onRemove: () => void
    onAddQuestion: () => void
    children: ReactNode
  }) {
  const label = group.label || 'Group'
  const parts = group.children.filter((child) => child.kind === 'group').length
  const choice: RuleChoice = group.rule === 'all' ? 'all' : group.count === 1 && group.min_each === 0 ? 'either' : 'any'
  const setChoice = (next: RuleChoice) => {
    if (next === 'all') onChange({ rule: 'all', min_each: 0 })
    else if (next === 'either') onChange({ rule: 'any', count: 1, min_each: 0 })
    else onChange({ rule: 'any', count: Math.max(1, Math.min(group.count > 1 ? group.count : group.children.length - 1, 500)) })
  }

  return (
    <section className={`group-card${group.rule === 'any' ? ' is-choice' : ''}`} aria-label={label}>
      <div className="group-card-head">
        <label className="inline-field">
          <span>Label</span>
          <input
            className="text-input number-input"
            value={group.label}
            onChange={(event) => onChange({ label: event.target.value })}
            placeholder="Part B, 11…"
            maxLength={100}
            aria-label={`Label of ${label}`}
          />
        </label>
        <label className="inline-field">
          <span>Counts</span>
          <select
            className="select select-small"
            value={choice}
            onChange={(event) => setChoice(event.target.value as RuleChoice)}
            aria-label={`Which parts of ${label} count`}
          >
            <option value="all">All parts</option>
            <option value="either">One of them (either / or)</option>
            <option value="any">Any number of them</option>
          </select>
        </label>
        {choice === 'any' && (
          <label className="inline-field">
            <span>Any</span>
            <NumberField
              className="text-input count-input"
              value={group.count}
              min={1}
              max={500}
              onChange={(count) => onChange({ count: Math.max(1, Math.round(count)) })}
              aria-label={`How many parts of ${label} count`}
            />
          </label>
        )}
        {group.rule === 'any' && parts > 0 && (
          <label className="inline-field" title="Pool the questions of its parts, and take at least this many from each">
            <span>At least</span>
            <NumberField
              className="text-input count-input"
              value={group.min_each}
              max={500}
              onChange={(minEach) => onChange({ min_each: Math.round(minEach) })}
              aria-label={`At least how many from each part of ${label}`}
            />
            <span>from each part</span>
          </label>
        )}
        <label className="inline-field" title="The most marks this group can give; 0 for no limit">
          <span>Cap</span>
          <NumberField
            className="text-input count-input"
            value={group.cap}
            max={10_000}
            onChange={(cap) => onChange({ cap })}
            aria-label={`Most marks ${label} can give`}
          />
        </label>
        <NodeActions label={label} {...rest}>
          <button type="button" className="icon-btn" onClick={onUngroup} title="Ungroup, keeping its questions" aria-label={`Ungroup ${label}`}>
            <Ungroup size={15} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-danger"
            onClick={onRemove}
            title="Remove with its questions"
            aria-label={`Remove ${label}`}
          >
            <Trash2 size={15} />
          </button>
        </NodeActions>
      </div>
      <p className="group-rule">
        <span className="rule-chip">{ruleText(group)}</span>
        <span className="muted">{formatMarks(maximum)} marks</span>
        {problem && (
          <span className="question-warning">
            <TriangleAlert size={13} aria-hidden />
            {problem}
          </span>
        )}
      </p>
      {preview ? (
        group.text && <RichText text={group.text} preview />
      ) : (
        <label className="field">
          <span className="field-label">Instructions or shared text</span>
          <textarea
            className="textarea"
            rows={1}
            value={group.text}
            onChange={(event) => onChange({ text: event.target.value })}
            placeholder="Optional, e.g. Answer any five questions. Text shared by its questions is given to the AI with each of them."
          />
        </label>
      )}
      {children}
      <button type="button" className="btn btn-small add-in-group" onClick={onAddQuestion}>
        <Plus size={13} aria-hidden />
        Add a question to {label}
      </button>
    </section>
  )
}

function QuestionCard({
  question,
  index,
  preview,
  autoFocus,
  onChange,
  onRemove,
  ...rest
}: Position &
  Moves & {
    question: Question
    index: number
    preview: boolean
    autoFocus: boolean
    onChange: (changes: Partial<Question>) => void
    onRemove: () => void
  }) {
  const label = questionLabel(question.number, index)
  const questionInput = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (autoFocus) questionInput.current?.focus()
  }, [autoFocus])

  return (
    <article className="question-card" aria-label={label}>
      <div className="question-card-head">
        <label className="inline-field">
          <span>No.</span>
          <input
            className="text-input number-input"
            value={question.number}
            onChange={(event) => onChange({ number: event.target.value })}
            placeholder={String(index + 1)}
            maxLength={40}
            aria-label={`Number of question ${index + 1}`}
          />
        </label>
        <label className="inline-field">
          <span>Marks</span>
          <NumberField
            className="text-input marks-input"
            value={question.max_marks}
            max={1000}
            onChange={(max_marks) => onChange({ max_marks })}
            aria-label={`Marks for ${label}`}
          />
        </label>
        {question.max_marks <= 0 && (
          <span className="question-warning">
            <TriangleAlert size={13} aria-hidden />
            Set the marks
          </span>
        )}
        <NodeActions label={label} {...rest}>
          <button
            type="button"
            className="icon-btn icon-btn-danger"
            onClick={onRemove}
            title="Remove question"
            aria-label={`Remove ${label}`}
          >
            <Trash2 size={15} />
          </button>
        </NodeActions>
      </div>
      {preview ? (
        <div className="question-preview">
          <PreviewField label="Question" text={question.question} />
          <PreviewField label="Model answer" text={question.answer} />
          <PreviewField label="Marking key" text={question.key} />
        </div>
      ) : (
        <>
          <label className="field">
            <span className="field-label">Question</span>
            <textarea
              ref={questionInput}
              className="textarea"
              rows={2}
              value={question.question}
              onChange={(event) => onChange({ question: event.target.value })}
              placeholder="The question as printed on the paper"
            />
          </label>
          <label className="field">
            <span className="field-label">Model answer</span>
            <textarea
              className="textarea"
              rows={4}
              value={question.answer}
              onChange={(event) => onChange({ answer: event.target.value })}
              placeholder="The expected answer or worked solution"
            />
          </label>
          <label className="field">
            <span className="field-label">Marking key</span>
            <textarea
              className="textarea"
              rows={2}
              value={question.key}
              onChange={(event) => onChange({ key: event.target.value })}
              placeholder="How marks are given, e.g. Formula: 1 mark. Working: 2 marks. Final answer: 1 mark."
            />
          </label>
        </>
      )}
    </article>
  )
}

function PreviewField({ label, text }: { label: string; text: string }) {
  return (
    <div className="preview-field">
      <span className="field-label">{label}</span>
      <RichText text={text} preview empty="Not given" />
    </div>
  )
}

/** A form to add many questions at once in a common layout. */
function PatternForm({
  defaultNumber,
  defaultSection,
  onAdd,
  onCancel,
}: {
  defaultNumber: string
  defaultSection: string
  onAdd: (pattern: Pattern) => void
  onCancel: () => void
}) {
  const [pattern, setPattern] = useState<Pattern>({
    kind: 'compulsory',
    count: 10,
    choose: 5,
    marks: 2,
    start: defaultNumber,
    section: defaultSection,
  })
  const set = (changes: Partial<Pattern>) => setPattern((current) => ({ ...current, ...changes }))
  const form = useRef<HTMLFormElement>(null)
  useEffect(() => form.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), [])
  const total =
    pattern.kind === 'any' ? Math.min(pattern.choose, pattern.count) * pattern.marks : pattern.count * pattern.marks

  return (
    <form
      ref={form}
      className="pattern-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (pattern.count >= 1) onAdd(pattern)
      }}
    >
      <div className="pattern-kinds" role="radiogroup" aria-label="Pattern">
        {(
          [
            ['compulsory', 'Compulsory questions', 'e.g. 10 questions of 2 marks, all to be answered'],
            ['pairs', 'Either / or pairs', 'e.g. 11 (a) OR 11 (b), up to 15 (a) OR 15 (b)'],
            ['any', 'Any of them', 'e.g. answer any 5 of 8'],
          ] as const
        ).map(([kind, title, detail]) => (
          <label key={kind} className={`pattern-kind${pattern.kind === kind ? ' is-active' : ''}`}>
            <input type="radio" name="pattern-kind" checked={pattern.kind === kind} onChange={() => set({ kind })} />
            <strong>{title}</strong>
            <span className="muted">{detail}</span>
          </label>
        ))}
      </div>
      <div className="pattern-fields">
        <label className="inline-field">
          <span>Section</span>
          <input
            className="text-input number-input"
            value={pattern.section}
            onChange={(event) => set({ section: event.target.value })}
            placeholder="None"
            maxLength={100}
          />
        </label>
        <label className="inline-field">
          <span>{pattern.kind === 'pairs' ? 'Pairs' : 'Questions'}</span>
          <NumberField className="text-input count-input" value={pattern.count} min={1} max={100} onChange={(count) => set({ count: Math.round(count) })} />
        </label>
        {pattern.kind === 'any' && (
          <label className="inline-field">
            <span>Answer any</span>
            <NumberField className="text-input count-input" value={pattern.choose} min={1} max={100} onChange={(choose) => set({ choose: Math.round(choose) })} />
          </label>
        )}
        <label className="inline-field">
          <span>Marks each</span>
          <NumberField className="text-input count-input" value={pattern.marks} max={1000} onChange={(marks) => set({ marks })} />
        </label>
        <label className="inline-field">
          <span>From no.</span>
          <input
            className="text-input number-input"
            value={pattern.start}
            onChange={(event) => set({ start: event.target.value })}
            maxLength={40}
          />
        </label>
      </div>
      <div className="pattern-actions">
        <span className="muted">Adds {formatMarks(total)} marks to the paper.</span>
        <button type="button" className="btn btn-small" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-small btn-primary">
          Add
        </button>
      </div>
    </form>
  )
}
