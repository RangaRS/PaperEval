import { useState } from 'react'

import type { DocumentInfo } from '../api'
import { pluralize } from '../utils'

/** Pick a document uploaded earlier that belongs to no evaluator, to use here instead of uploading it again. */
export function UseEarlierUpload({
  documents,
  label,
  button,
  onUse,
}: {
  documents: DocumentInfo[]
  label: string
  button: string
  onUse: (documentId: string) => void
}) {
  const [choice, setChoice] = useState('')
  if (documents.length === 0) return null
  const chosen = documents.some((document) => document.id === choice) ? choice : ''
  return (
    <div className="use-earlier">
      <span className="hint">{label}</span>
      <select className="select select-small" value={chosen} onChange={(event) => setChoice(event.target.value)}>
        <option value="">Choose a file…</option>
        {documents.map((document) => (
          <option key={document.id} value={document.id}>
            {document.filename} ({pluralize(document.pages.length, 'page')},{' '}
            {document.pages.filter((page) => page.ocr).length} with text)
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn btn-small"
        disabled={!chosen}
        onClick={() => {
          onUse(chosen)
          setChoice('')
        }}
      >
        {button}
      </button>
    </div>
  )
}
