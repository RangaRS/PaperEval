import { CircleCheck, FileSearch, LoaderCircle } from 'lucide-react'
import { useRef, useState } from 'react'

import { api, type DocumentInfo, type Exam, type ModelInfo } from '../api'
import { useElapsedSeconds } from '../hooks'
import { errorMessage, formatElapsed, pluralize } from '../utils'
import { Dialog } from './Dialog'
import { ModelSelect } from './ModelSelect'
import { UploadButton } from './Sidebar'

interface KeyFromDocumentDialogProps {
  open: boolean
  onClose: () => void
  documents: DocumentInfo[]
  model: string
  onModelChange: (model: string) => void
  models: ModelInfo[]
  addedModels: string[]
  /** The vision model that reads pages without text. */
  ocrModel: string
  acceptedExtensions: string[]
  uploading: boolean
  onUpload: (files: File[]) => void
  /** Extract the text of the document's pages that have none. */
  prepare: (documentId: string, signal: AbortSignal) => Promise<void>
  onCreated: (exam: Exam) => void
}

type Step = 'extract' | 'read'

/** Read an answer key from an uploaded document with a model. */
export function KeyFromDocumentDialog(props: KeyFromDocumentDialogProps) {
  const [busy, setBusy] = useState(false)
  const close = () => {
    if (!busy) props.onClose()
  }
  return (
    <Dialog open={props.open} title="Read an answer key from a document" onClose={close} locked={busy}>
      {props.open && <KeyFromDocumentForm {...props} onBusyChange={setBusy} />}
    </Dialog>
  )
}

function KeyFromDocumentForm({
  onClose,
  documents,
  model,
  onModelChange,
  models,
  addedModels,
  ocrModel,
  acceptedExtensions,
  uploading,
  onUpload,
  prepare,
  onCreated,
  onBusyChange,
}: KeyFromDocumentDialogProps & { onBusyChange: (busy: boolean) => void }) {
  const [choice, setChoice] = useState<string | null>(null)
  const [step, setStep] = useState<Step | null>(null)
  const [startedAt, setStartedAt] = useState<number>()
  const [error, setError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const seconds = useElapsedSeconds(startedAt)

  // Until a document is chosen, offer the newest one, such as one just uploaded.
  const document = documents.find((candidate) => candidate.id === choice) ?? documents[0]
  const missing = document ? document.pages.filter((page) => !page.ocr).length : 0

  const begin = (next: Step) => {
    setStep(next)
    setStartedAt(Date.now())
  }

  const read = async () => {
    if (!document || !model) return
    const abort = new AbortController()
    controller.current = abort
    onBusyChange(true)
    setError(null)
    try {
      if (missing > 0) {
        begin('extract')
        await prepare(document.id, abort.signal)
      }
      begin('read')
      const exam = await api.examFromDocument({ document_id: document.id, model }, abort.signal)
      onBusyChange(false)
      onCreated(exam)
      onClose()
    } catch (caught) {
      if (!abort.signal.aborted) setError(errorMessage(caught))
      setStep(null)
      setStartedAt(undefined)
      onBusyChange(false)
    }
  }

  if (step) {
    return (
      <div className="dialog-progress" role="status">
        <ol className="steps">
          {missing > 0 || step === 'extract' ? (
            <li className={step === 'extract' ? 'is-current' : 'is-done'}>
              {step === 'extract' ? <LoaderCircle size={16} className="spin" /> : <CircleCheck size={16} />}
              <span>Read the pages with {ocrModel}</span>
            </li>
          ) : null}
          <li className={step === 'read' ? 'is-current' : undefined}>
            {step === 'read' ? <LoaderCircle size={16} className="spin" /> : <span className="step-dot" />}
            <span>Find the questions, answers and marks with {model}</span>
          </li>
        </ol>
        <p className="elapsed">{formatElapsed(seconds)}</p>
        <p className="hint">Long answer keys can take a few minutes.</p>
        <footer className="dialog-footer">
          <button type="button" className="btn" onClick={() => controller.current?.abort()}>
            Cancel
          </button>
        </footer>
      </div>
    )
  }

  return (
    <form
      className="dialog-form"
      onSubmit={(event) => {
        event.preventDefault()
        void read()
      }}
    >
      <p className="hint">
        Upload the answer key (the question paper with its answers and marking scheme) as a PDF or image, and a model
        reads its questions, model answers, marking scheme and marks into a new answer key that you can check and edit.
      </p>
      <div className="field">
        <span className="field-label">Document</span>
        {documents.length > 0 ? (
          <select className="select" value={document?.id ?? ''} onChange={(event) => setChoice(event.target.value)}>
            {documents.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.filename} ({pluralize(candidate.pages.length, 'page')})
              </option>
            ))}
          </select>
        ) : (
          <p className="field-value muted">No documents yet.</p>
        )}
        <div className="field-row">
          <UploadButton accept={acceptedExtensions} busy={uploading} onFiles={onUpload} label="Upload the answer key" />
        </div>
      </div>
      <label className="field">
        <span className="field-label">Model</span>
        <ModelSelect value={model} onChange={onModelChange} models={models} added={addedModels} />
      </label>
      {document && missing > 0 && (
        <p className="hint">
          {pluralize(missing, 'page')} of this document {missing === 1 ? 'has' : 'have'} no text yet, so{' '}
          {missing === 1 ? 'it is' : 'they are'} read first with {ocrModel || 'the vision model chosen at the top'}.
        </p>
      )}
      {error && <p className="dialog-problem">{error}</p>}
      <footer className="dialog-footer">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!document || !model || (missing > 0 && !ocrModel) || uploading}
        >
          <FileSearch size={15} aria-hidden />
          Read answer key
        </button>
      </footer>
    </form>
  )
}
