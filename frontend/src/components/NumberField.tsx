import { useState, type InputHTMLAttributes } from 'react'

import { formatMarks } from '../exams'

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'>

const parse = (text: string): number | null => {
  const value = Number(text.trim().replace(',', '.'))
  return text.trim() !== '' && Number.isFinite(value) ? value : null
}

/**
 * A number input that keeps what is typed (such as "2." on the way to "2.5")
 * and reports each valid number as it is typed.
 */
export function NumberField({
  value,
  onChange,
  min = 0,
  max = Infinity,
  ...props
}: InputProps & { value: number; onChange: (value: number) => void; min?: number; max?: number }) {
  const [text, setText] = useState(formatMarks(value))
  const [shown, setShown] = useState(value)
  if (value !== shown) {
    // Changed from outside, e.g. after saving: show the new value.
    setShown(value)
    if (parse(text) !== value) setText(formatMarks(value))
  }
  return (
    <input
      {...props}
      type="text"
      inputMode="decimal"
      value={text}
      onChange={(event) => {
        setText(event.target.value)
        const number = parse(event.target.value)
        if (number !== null && number >= min && number <= max) {
          setShown(number)
          onChange(number)
        }
      }}
      onBlur={(event) => {
        setText(formatMarks(value))
        props.onBlur?.(event)
      }}
      aria-invalid={(() => {
        const number = parse(text)
        return number === null || number < min || number > max
      })()}
    />
  )
}

/**
 * A marks input that saves when it loses focus or Enter is pressed. An empty
 * field shows the placeholder; clearing it and leaving asks to reset.
 */
export function MarksField({
  value,
  max,
  onCommit,
  ...props
}: InputProps & { value: number | null; max: number; onCommit: (value: number | null) => void }) {
  const format = (marks: number | null) => (marks === null ? '' : formatMarks(marks))
  const [text, setText] = useState(format(value))
  const [shown, setShown] = useState(value)
  if (value !== shown) {
    setShown(value)
    setText(format(value))
  }
  const number = parse(text)
  const invalid = text.trim() !== '' && (number === null || number < 0 || number > max)

  const commit = () => {
    if (text.trim() === '') {
      if (value !== null) onCommit(null)
      else setText(format(value))
      return
    }
    if (invalid || number === null) {
      setText(format(value))
      return
    }
    if (number !== value) onCommit(number)
  }

  return (
    <input
      {...props}
      type="text"
      inputMode="decimal"
      value={text}
      aria-invalid={invalid}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          setText(format(value))
          event.currentTarget.blur()
        }
      }}
    />
  )
}
