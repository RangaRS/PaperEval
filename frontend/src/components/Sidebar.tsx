import { ChevronDown, FileDown, FileText, Image as ImageIcon, LoaderCircle, ScanText, Square, Trash2, Upload } from 'lucide-react'
import { memo, useRef, useState } from 'react'

import type { DocumentInfo, Page } from '../api'
import { isActive, pageKey, pageStatus, type OcrJob, type PageStatus } from '../ocrQueue'
import { pluralize } from '../utils'
import { StatusBadge } from './StatusBadge'

export interface Selection {
  documentId: string
  pageNumber: number
}

export interface UploadProgress {
  name: string
  index: number
  total: number
}

interface SidebarProps {
  documents: DocumentInfo[]
  loading: boolean
  jobs: ReadonlyMap<string, OcrJob>
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
}

export function Sidebar(props: SidebarProps) {
  const { documents, loading, upload, acceptedExtensions, maxUploadMb, onUpload } = props
  return (
    <aside className="sidebar" aria-label="Documents">
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
          <p className="sidebar-empty">No documents yet. Upload a PDF or an image to get started.</p>
        )}
        {documents.map((document) => (
          <DocumentGroup key={document.id} document={document} {...props} />
        ))}
      </div>
    </aside>
  )
}

export function UploadButton({
  accept,
  busy,
  onFiles,
  large = false,
}: {
  accept: string[]
  busy: boolean
  onFiles: (files: File[]) => void
  large?: boolean
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
        Upload PDF or image
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
  selection,
  onSelect,
  onExtract,
  onStop,
  onExtractAll,
  onStopAll,
  onDownload,
  onDelete,
}: SidebarProps & { document: DocumentInfo }) {
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
