import {
  ChevronDown,
  CircleAlert,
  ClipboardCheck,
  FileDown,
  Files,
  FileText,
  Image as ImageIcon,
  KeyRound,
  LoaderCircle,
  ScanText,
  Square,
  Trash2,
  Upload,
} from 'lucide-react'
import { memo, useRef, useState, type ReactNode } from 'react'

import type { DocumentInfo, EvaluationSummary, Page } from '../api'
import { isRunning, type EvaluationRun } from '../evaluationRunner'
import { formatMarks } from '../exams'
import { isActive, pageKey, pageStatus, type OcrJob, type PageStatus } from '../ocrQueue'
import { pluralize } from '../utils'
import { StatusBadge } from './StatusBadge'

export type SidebarMode = 'papers' | 'keys'

/** The sidebar, with tabs for the uploaded papers and the answer keys. */
export function Sidebar({
  mode,
  onModeChange,
  paperCount,
  keyCount,
  children,
}: {
  mode: SidebarMode
  onModeChange: (mode: SidebarMode) => void
  paperCount: number
  keyCount: number
  children: ReactNode
}) {
  const tab = (value: SidebarMode, icon: ReactNode, label: string, count: number) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === value}
      className={mode === value ? 'is-active' : undefined}
      onClick={() => onModeChange(value)}
    >
      {icon}
      {label}
      {count > 0 && <span className="tab-count">{count}</span>}
    </button>
  )
  return (
    <aside className="sidebar" aria-label={mode === 'papers' ? 'Papers' : 'Answer keys'}>
      <div className="tabs sidebar-tabs" role="tablist" aria-label="Show">
        {tab('papers', <Files size={15} aria-hidden />, 'Papers', paperCount)}
        {tab('keys', <KeyRound size={15} aria-hidden />, 'Answer keys', keyCount)}
      </div>
      {children}
    </aside>
  )
}

export interface Selection {
  documentId: string
  pageNumber: number
}

export interface UploadProgress {
  name: string
  index: number
  total: number
}

interface PaperListProps {
  documents: DocumentInfo[]
  loading: boolean
  jobs: ReadonlyMap<string, OcrJob>
  evaluations: EvaluationSummary[]
  runs: ReadonlyMap<string, EvaluationRun>
  selection: Selection | null
  upload: UploadProgress | null
  acceptedExtensions: string[]
  maxUploadMb: number
  onUpload: (files: File[]) => void
  onSelect: (documentId: string, pageNumber: number) => void
  onExtract: (documentId: string, pageNumber: number) => void
  onStop: (documentId: string, pageNumber: number) => void
  onExtractAll: (document: DocumentInfo) => void
  onStopAll: (document: DocumentInfo) => void
  onDownload: (document: DocumentInfo) => void
  onDelete: (document: DocumentInfo) => void
  onOpenMarks: (document: DocumentInfo) => void
}

/** The uploaded papers and their pages. */
export function PaperList(props: PaperListProps) {
  const { documents, loading, upload, acceptedExtensions, maxUploadMb, onUpload } = props
  return (
    <>
      <div className="sidebar-upload">
        <UploadButton accept={acceptedExtensions} busy={upload !== null} onFiles={onUpload} />
        <p className="hint">
          {upload
            ? `Splitting ${upload.name}${upload.total > 1 ? ` (${upload.index} of ${upload.total})` : ''}…`
            : `PDF or image, up to ${maxUploadMb} MB. Or drop files anywhere.`}
        </p>
      </div>
      <div className="document-list">
        {loading && documents.length === 0 && <p className="sidebar-empty">Loading documents…</p>}
        {!loading && documents.length === 0 && (
          <p className="sidebar-empty">
            No papers yet. Upload each student's answer script as a PDF or images, one file per student.
          </p>
        )}
        {documents.map((document) => (
          <DocumentGroup key={document.id} document={document} {...props} />
        ))}
      </div>
    </>
  )
}

export function UploadButton({
  accept,
  busy,
  onFiles,
  large = false,
  label = 'Upload PDF or image',
}: {
  accept: string[]
  busy: boolean
  onFiles: (files: File[]) => void
  large?: boolean
  label?: string
}) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <button
        type="button"
        className={`btn btn-primary${large ? ' btn-large' : ' btn-block'}`}
        onClick={() => input.current?.click()}
      >
        {busy ? <LoaderCircle size={16} className="spin" aria-hidden /> : <Upload size={16} aria-hidden />}
        {label}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={['application/pdf', 'image/*', ...accept].join(',')}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          event.target.value = '' // Allow choosing the same file again.
          if (files.length > 0) onFiles(files)
        }}
      />
    </>
  )
}

function DocumentGroup({
  document,
  jobs,
  evaluations,
  runs,
  selection,
  onSelect,
  onExtract,
  onStop,
  onExtractAll,
  onStopAll,
  onDownload,
  onDelete,
  onOpenMarks,
}: PaperListProps & { document: DocumentInfo }) {
  const [collapsed, setCollapsed] = useState(false)
  const statuses = document.pages.map((page) => pageStatus(page, jobs.get(pageKey(document.id, page.number))))
  const extracted = document.pages.filter((page) => page.ocr).length
  const active = statuses.filter((status) => status === 'queued' || status === 'running').length
  const remaining = document.pages.filter(
    (page) => !page.ocr && !isActive(jobs.get(pageKey(document.id, page.number))),
  ).length
  const KindIcon = document.kind === 'pdf' ? FileText : ImageIcon

  return (
    <section className="document">
      <button
        type="button"
        className="document-toggle"
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
        title={document.filename}
      >
        <ChevronDown size={16} className={`chevron${collapsed ? ' is-collapsed' : ''}`} aria-hidden />
        <KindIcon size={16} className="document-icon" aria-hidden />
        <span className="document-name">{document.filename}</span>
      </button>
      <div className="document-meta">
        <span className="document-summary">
          {extracted} of {pluralize(document.pages.length, 'page')} extracted
        </span>
        <div className="document-actions">
          {active > 0 ? (
            <button type="button" className="btn btn-small" onClick={() => onStopAll(document)}>
              <Square size={13} aria-hidden />
              Stop all
            </button>
          ) : (
            remaining > 0 && (
              <button
                type="button"
                className="btn btn-small btn-accent"
                onClick={() => onExtractAll(document)}
                title={`Extract the text of ${pluralize(remaining, 'page')} without text`}
              >
                <ScanText size={13} aria-hidden />
                Extract all
              </button>
            )
          )}
          <button
            type="button"
            className="icon-btn"
            onClick={() => onDownload(document)}
            disabled={extracted === 0}
            title="Download the extracted text"
            aria-label="Download the extracted text"
          >
            <FileDown size={15} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-danger"
            onClick={() => onDelete(document)}
            title="Delete document"
            aria-label="Delete document"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
      <div className="document-progress" title={`${extracted} of ${document.pages.length} pages extracted`}>
        <span style={{ width: `${(extracted / document.pages.length) * 100}%` }} />
      </div>
      <MarksLine
        run={runs.get(document.id)}
        evaluation={evaluations.find((evaluation) => evaluation.document_id === document.id)}
        onOpen={() => onOpenMarks(document)}
      />
      {!collapsed && (
        <ul className="page-list">
          {document.pages.map((page, index) => (
            <PageRow
              key={page.number}
              documentId={document.id}
              page={page}
              status={statuses[index]}
              selected={selection?.documentId === document.id && selection.pageNumber === page.number}
              onSelect={onSelect}
              onExtract={onExtract}
              onStop={onStop}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

const PageRow = memo(function PageRow({
  documentId,
  page,
  status,
  selected,
  onSelect,
  onExtract,
  onStop,
}: {
  documentId: string
  page: Page
  status: PageStatus
  selected: boolean
  onSelect: (documentId: string, pageNumber: number) => void
  onExtract: (documentId: string, pageNumber: number) => void
  onStop: (documentId: string, pageNumber: number) => void
}) {
  const active = status === 'queued' || status === 'running'
  return (
    <li className={`page-row${selected ? ' is-selected' : ''}`}>
      <button
        type="button"
        className="page-row-select"
        onClick={() => onSelect(documentId, page.number)}
        aria-current={selected ? 'page' : undefined}
      >
        <img className="page-thumb" src={page.thumbnail_url} alt="" loading="lazy" draggable={false} />
        <span className="page-row-text">
          <span className="page-row-title">Page {page.number}</span>
          <StatusBadge status={status} />
        </span>
      </button>
      {active ? (
        <button
          type="button"
          className="btn btn-small"
          onClick={() => onStop(documentId, page.number)}
          aria-label={`Stop page ${page.number}`}
        >
          <Square size={13} aria-hidden />
          Stop
        </button>
      ) : (
        <button
          type="button"
          className={`btn btn-small${status === 'idle' ? ' btn-accent' : ''}`}
          onClick={() => onExtract(documentId, page.number)}
          aria-label={`Extract text from page ${page.number}`}
        >
          <ScanText size={13} aria-hidden />
          {status === 'idle' ? 'Extract' : 'Re-run'}
        </button>
      )}
    </li>
  )
})

const RUN_STEPS = {
  extract: 'Reading pages…',
  split: 'Finding answers…',
  mark: 'Marking',
}

/** The paper's marks, or how its evaluation is going. */
function MarksLine({
  run,
  evaluation,
  onOpen,
}: {
  run: EvaluationRun | undefined
  evaluation: EvaluationSummary | undefined
  onOpen: () => void
}) {
  let content: ReactNode
  if (isRunning(run)) {
    const step =
      run!.status === 'queued'
        ? 'Waiting to be evaluated'
        : run!.step === 'mark'
          ? `Marking ${run!.toMark - run!.marking.length} of ${run!.toMark}…`
          : RUN_STEPS[run!.step ?? 'extract']
    content = (
      <>
        <LoaderCircle size={13} className="spin" aria-hidden />
        {step}
      </>
    )
  } else if (run?.status === 'error' && !evaluation) {
    content = (
      <>
        <CircleAlert size={13} aria-hidden />
        Evaluation failed
      </>
    )
  } else if (evaluation) {
    content = (
      <>
        <ClipboardCheck size={13} aria-hidden />
        <strong>
          {formatMarks(evaluation.marks)} / {formatMarks(evaluation.max_marks)}
        </strong>
        {!evaluation.complete && <span className="marks-incomplete">incomplete</span>}
        {evaluation.student_name && <span className="truncate">· {evaluation.student_name}</span>}
      </>
    )
  } else {
    return null
  }
  const state = isRunning(run) ? ' is-running' : run?.status === 'error' && !evaluation ? ' is-error' : ''
  return (
    <button type="button" className={`marks-line${state}`} onClick={onOpen} title="Show the marks">
      {content}
    </button>
  )
}
