import { ArrowDown, ArrowUp, Plus, Sigma, Trash2, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { Question } from '../api'
import { blankQuestion, questionLabel } from '../exams'
import { isBoolean, useLocalStorage } from '../hooks'
import { NumberField } from './NumberField'
import { RichText } from './RichText'

/** The questions of an evaluator, each with its model answer, marking key and marks, to check and edit. */
export function QuestionsEditor({
  questions,
  onChange,
}: {
  questions: Question[]
  onChange: (questions: Question[]) => void
}) {
  const [preview, setPreview] = useLocalStorage('papereval.keyPreview', false, isBoolean)
  const [focusId, setFocusId] = useState<string | null>(null)

  const change = (id: string, changes: Partial<Question>) =>
    onChange(questions.map((question) => (question.id === id ? { ...question, ...changes } : question)))
  const move = (index: number, offset: number) => {
    const next = [...questions]
    const [question] = next.splice(index, 1)
    next.splice(index + offset, 0, question)
    onChange(next)
  }
  const remove = (question: Question, index: number) => {
    const hasContent = question.question || question.answer || question.key
    if (hasContent && !window.confirm(`Remove ${questionLabel(question.number, index)}?`)) return
    onChange(questions.filter((candidate) => candidate.id !== question.id))
  }
  const add = () => {
    const question = blankQuestion(questions)
    onChange([...questions, question])
    setFocusId(question.id)
  }

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
      <ol className="question-list">
        {questions.map((question, index) => (
          <li key={question.id}>
            <QuestionCard
              question={question}
              index={index}
              count={questions.length}
              preview={preview}
              autoFocus={question.id === focusId}
              onChange={(changes) => change(question.id, changes)}
              onMove={(offset) => move(index, offset)}
              onRemove={() => remove(question, index)}
            />
          </li>
        ))}
      </ol>
      <button type="button" className="btn add-question" onClick={add}>
        <Plus size={15} aria-hidden />
        Add a question
      </button>
    </>
  )
}

function QuestionCard({
  question,
  index,
  count,
  preview,
  autoFocus,
  onChange,
  onMove,
  onRemove,
}: {
  question: Question
  index: number
  count: number
  preview: boolean
  autoFocus: boolean
  onChange: (changes: Partial<Question>) => void
  onMove: (offset: number) => void
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
        <div className="question-card-actions">
          <button
            type="button"
            className="icon-btn"
            onClick={() => onMove(-1)}
            disabled={index === 0}
            title="Move up"
            aria-label={`Move ${label} up`}
          >
            <ArrowUp size={15} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => onMove(1)}
            disabled={index === count - 1}
            title="Move down"
            aria-label={`Move ${label} down`}
          >
            <ArrowDown size={15} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-danger"
            onClick={onRemove}
            title="Remove question"
            aria-label={`Remove ${label}`}
          >
            <Trash2 size={15} />
          </button>
        </div>
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
