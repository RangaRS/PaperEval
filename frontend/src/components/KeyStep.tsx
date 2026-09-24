import { Eye, FileJson, FileText, RotateCcw, Square, TriangleAlert, Upload, X } from 'lucide-react'
import { useRef } from 'react'

import type { DocumentInfo, Question } from '../api'
import { isKeyReading, type KeyRead } from '../evaluator'
import { formatMarks, totalMarks } from '../exams'
import type { OcrJob } from '../ocrQueue'
import { pluralize } from '../utils'
import { KeyReadProgress } from './KeyReadProgress'
import { QuestionsEditor } from './QuestionsEditor'
import { UploadZone } from './UploadButton'
import { UseEarlierUpload } from './UseEarlierUpload'

interface KeyStepProps {
  keyDocument: DocumentInfo | undefined
  /** Documents that belong to no evaluator, which can be used as the key file. */
  looseDocuments: DocumentInfo[]
  keyRead: KeyRead | undefined
  jobs: ReadonlyMap<string, OcrJob>
  ocrModel: string
  gradingModel: string
  accept: string[]
  uploading: boolean
  questions: Question[]
  onQuestionsChange: (questions: Question[]) => void
  onUploadKey: (files: File[]) => void
  onUseDocument: (documentId: string) => void
  /** Read the questions from the key file; with `extractAll`, extract every page's text again first. */
  onReadKey: (extractAll: boolean) => void
  onCancelKeyRead: () => void
  onDismissKeyRead: () => void
  onViewKeyPages: () => void
  onImportJson: (file: File) => void
}

/** Step 1 of an evaluator: the question paper with its answer key, and the questions read from it. */
export function KeyStep({
  keyDocument,
  looseDocuments,
  keyRead,
  jobs,
  ocrModel,
  gradingModel,
  accept,
  uploading,
  questions,
  onQuestionsChange,
  onUploadKey,
  onUseDocument,
  onReadKey,
  onCancelKeyRead,
  onDismissKeyRead,
  onViewKeyPages,
  onImportJson,
}: KeyStepProps) {
  const replaceInput = useRef<HTMLInputElement>(null)
  const jsonInput = useRef<HTMLInputElement>(null)
  const reading = isKeyReading(keyRead)
  const withText = keyDocument ? keyDocument.pages.filter((page) => page.ocr).length : 0
  const unmarked = questions.filter((question) => question.max_marks <= 0).length

  const readAgain = (extractAll: boolean) => {
    const replacing = questions.length > 0
    if (
      replacing &&
      !window.confirm(
        `Read the questions again from ${keyDocument?.filename}? This replaces the ${pluralize(questions.length, 'question')} below, and any changes you made to them.`,
      )
    ) {
      return
    }
    onReadKey(extractAll)
  }

  return (
    <div className="step-body">
      <section className="step-card" aria-label="Question paper and key">
        <header className="step-card-header">
          <h2>Question paper &amp; key</h2>
          {keyDocument && !reading && (
            <div className="toolbar-group">
              <button type="button" className="btn btn-small" onClick={onViewKeyPages}>
                <Eye size={13} aria-hidden />
                View pages
              </button>
              <button type="button" className="btn btn-small" onClick={() => readAgain(false)} disabled={!gradingModel}>
                <RotateCcw size={13} aria-hidden />
                {questions.length > 0 ? 'Read the questions again' : 'Read the questions'}
              </button>
              <button type="button" className="btn btn-small" onClick={() => replaceInput.current?.click()}>
                <Upload size={13} aria-hidden />
                Replace file
              </button>
              <input
                ref={replaceInput}
                type="file"
                hidden
                accept={['application/pdf', 'image/*', ...accept].join(',')}
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])]
                  event.target.value = ''
                  if (files.length > 0) onUploadKey(files)
                }}
              />
            </div>
          )}
        </header>

        {keyDocument ? (
          <p className="key-file">
            <FileText size={16} aria-hidden />
            <strong>{keyDocument.filename}</strong>
            <span className="muted">
              {pluralize(keyDocument.pages.length, 'page')} · text extracted from {withText} of{' '}
              {keyDocument.pages.length}
            </span>
          </p>
        ) : (
          !keyRead && (
            <>
              <UploadZone
                title="Upload the question paper with its answer key"
                hint="A PDF, or an image. The text of every page is extracted, one page at a time, and then the AI lists each question with its model answer, marking key and marks. You can check and correct them below."
                label={uploading ? 'Uploading…' : 'Upload the key file'}
                accept={accept}
                busy={uploading}
                onFiles={onUploadKey}
              />
              <UseEarlierUpload
                documents={looseDocuments}
                label="Or use a file you uploaded earlier:"
                button="Use it"
                onUse={onUseDocument}
              />
            </>
          )
        )}

        {keyRead && keyDocument && (
          <>
            <KeyReadProgress
              read={keyRead}
              document={keyDocument}
              jobs={jobs}
              ocrModel={ocrModel}
              model={gradingModel}
            />
            <div className="step-card-actions">
              {reading ? (
                <button type="button" className="btn" onClick={onCancelKeyRead}>
                  <Square size={13} aria-hidden />
                  Stop
                </button>
              ) : (
                <>
                  <button type="button" className="btn btn-primary" onClick={() => onReadKey(false)}>
                    <RotateCcw size={14} aria-hidden />
                    Try again
                  </button>
                  <button type="button" className="btn" onClick={() => onReadKey(true)}>
                    Extract the pages again and retry
                  </button>
                  <button type="button" className="btn" onClick={onDismissKeyRead}>
                    <X size={14} aria-hidden />
                    Close
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </section>

      <section className="step-card" aria-label="Questions">
        <header className="step-card-header">
          <h2>Questions</h2>
          <span className="muted">
            {pluralize(questions.length, 'question')} · {formatMarks(totalMarks(questions))} marks
          </span>
          {unmarked > 0 && (
            <span className="exam-meta-warning">
              <TriangleAlert size={13} aria-hidden />
              {unmarked === 1 ? '1 question has' : `${unmarked} questions have`} no marks
            </span>
          )}
          <div className="toolbar-group">
            <button
              type="button"
              className="btn btn-small"
              onClick={() => jsonInput.current?.click()}
              title="Load questions saved as JSON"
            >
              <FileJson size={13} aria-hidden />
              Import JSON
            </button>
            <input
              ref={jsonInput}
              type="file"
              hidden
              accept=".json,application/json"
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) onImportJson(file)
              }}
            />
          </div>
        </header>
        {questions.length === 0 && (
          <p className="hint step-empty">
            {reading
              ? 'The questions appear here when the AI has read the key file.'
              : 'The questions appear here once the key file is read. You can also type them in yourself.'}
          </p>
        )}
        <QuestionsEditor questions={questions} onChange={onQuestionsChange} />
      </section>
    </div>
  )
}
