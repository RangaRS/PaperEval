import { Columns2, FileUp, ScanText } from 'lucide-react'

import { UploadButton } from './Sidebar'

export function EmptyState({
  hasDocuments,
  accept,
  busy,
  onUpload,
}: {
  hasDocuments: boolean
  accept: string[]
  busy: boolean
  onUpload: (files: File[]) => void
}) {
  if (hasDocuments) {
    return (
      <div className="empty-state">
        <Columns2 size={40} strokeWidth={1.5} aria-hidden />
        <h2>Select a page</h2>
        <p>Pick a page on the left to see it next to its extracted text and the paper's marks.</p>
      </div>
    )
  }
  return (
    <div className="empty-state">
      <FileUp size={40} strokeWidth={1.5} aria-hidden />
      <h2>Upload answer scripts</h2>
      <p>
        Upload each student's script as a PDF or images. Every page becomes its own image: press{' '}
        <ScanText size={14} className="inline-icon" aria-label="Extract" /> to read a page with an Ollama vision model,
        then evaluate the paper against an answer key and check its marks next to the pages.
      </p>
      <UploadButton accept={accept} busy={busy} onFiles={onUpload} large />
      <p className="hint">or drop files anywhere in this window</p>
    </div>
  )
}
