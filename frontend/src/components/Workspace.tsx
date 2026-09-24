import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  FileText,
  Image as ImageIcon,
  ScanText,
} from 'lucide-react'
import type { ReactNode } from 'react'

import type { DocumentInfo, Page } from '../api'
import type { OcrJob } from '../ocrQueue'
import { ImageViewer } from './ImageViewer'
import { ResultPanel } from './ResultPanel'
import { SplitPane } from './SplitPane'

export type WorkspacePanel = 'text' | 'marks'

interface WorkspaceProps {
  document: DocumentInfo
  page: Page
  job: OcrJob | undefined
  model: string
  /** What the right-hand side shows: the page's text, or the paper's marks. */
  panel: WorkspacePanel
  onPanelChange: (panel: WorkspacePanel) => void
  /** The paper's marks, or null for a document that has none, such as a key file. */
  marks: ReactNode | null
  /** Where the back button goes, e.g. the evaluator's answer papers. */
  backLabel: string
  onBack: () => void
  onSelectPage: (pageNumber: number) => void
  onExtract: () => void
  onStop: () => void
  onDismiss: () => void
  onError: (message: string) => void
}

/** A document's page image on the left, and the page's extracted text or the paper's marks on the right. */
export function Workspace({
  document,
  page,
  panel,
  onPanelChange,
  marks,
  backLabel,
  onBack,
  onSelectPage,
  ...resultProps
}: WorkspaceProps) {
  const count = document.pages.length
  const KindIcon = document.kind === 'pdf' ? FileText : ImageIcon
  const showMarks = marks !== null && panel === 'marks'
  return (
    <section className="workspace" aria-label={`${document.filename}, page ${page.number}`}>
      <div className="workspace-header">
        <button type="button" className="btn btn-small back-button" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden />
          {backLabel}
        </button>
        <h1 className="workspace-title" title={document.filename}>
          <KindIcon size={16} aria-hidden />
          <span className="truncate">{document.filename}</span>
        </h1>
        {marks !== null && (
          <div className="segmented segmented-small workspace-switch" role="group" aria-label="Show on the right">
            <button
              type="button"
              className={!showMarks ? 'is-active' : undefined}
              aria-pressed={!showMarks}
              onClick={() => onPanelChange('text')}
            >
              <ScanText size={13} aria-hidden />
              Page text
            </button>
            <button
              type="button"
              className={showMarks ? 'is-active' : undefined}
              aria-pressed={showMarks}
              onClick={() => onPanelChange('marks')}
            >
              <ClipboardCheck size={13} aria-hidden />
              Marks
            </button>
          </div>
        )}
        {count > 1 && (
          <nav className={`pager${marks === null ? ' pager-end' : ''}`} aria-label="Pages">
            <button
              type="button"
              className="icon-btn"
              onClick={() => onSelectPage(page.number - 1)}
              disabled={page.number <= 1}
              aria-label="Previous page"
              title="Previous page"
            >
              <ChevronLeft size={18} />
            </button>
            <span className="pager-label">
              Page {page.number} of {count}
            </span>
            <button
              type="button"
              className="icon-btn"
              onClick={() => onSelectPage(page.number + 1)}
              disabled={page.number >= count}
              aria-label="Next page"
              title="Next page"
            >
              <ChevronRight size={18} />
            </button>
          </nav>
        )}
      </div>
      <SplitPane
        storageKey="papereval.split"
        left={
          <ImageViewer
            src={page.image_url}
            width={page.width}
            height={page.height}
            alt={`Page ${page.number} of ${document.filename}`}
          />
        }
        right={showMarks ? marks : <ResultPanel document={document} page={page} {...resultProps} />}
      />
    </section>
  )
}
