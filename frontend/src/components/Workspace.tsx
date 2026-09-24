import { ChevronLeft, ChevronRight, ClipboardCheck, FileText, Image as ImageIcon, ScanText } from 'lucide-react'
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
  marks: ReactNode
  onSelectPage: (pageNumber: number) => void
  onExtract: () => void
  onStop: () => void
  onDismiss: () => void
  onError: (message: string) => void
}

/** The selected page's image on the left, and its extracted text or the paper's marks on the right. */
export function Workspace({
  document,
  page,
  panel,
  onPanelChange,
  marks,
  onSelectPage,
  ...resultProps
}: WorkspaceProps) {
  const count = document.pages.length
  const KindIcon = document.kind === 'pdf' ? FileText : ImageIcon
  return (
    <section className="workspace" aria-label={`${document.filename}, page ${page.number}`}>
      <div className="workspace-header">
        <h1 className="workspace-title" title={document.filename}>
          <KindIcon size={16} aria-hidden />
          <span className="truncate">{document.filename}</span>
        </h1>
        <div className="segmented segmented-small workspace-switch" role="group" aria-label="Show on the right">
          <button
            type="button"
            className={panel === 'text' ? 'is-active' : undefined}
            aria-pressed={panel === 'text'}
            onClick={() => onPanelChange('text')}
          >
            <ScanText size={13} aria-hidden />
            Page text
          </button>
          <button
            type="button"
            className={panel === 'marks' ? 'is-active' : undefined}
            aria-pressed={panel === 'marks'}
            onClick={() => onPanelChange('marks')}
          >
            <ClipboardCheck size={13} aria-hidden />
            Marks
          </button>
        </div>
        {count > 1 && (
          <nav className="pager" aria-label="Pages">
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
        right={panel === 'marks' ? marks : <ResultPanel document={document} page={page} {...resultProps} />}
      />
    </section>
  )
}
