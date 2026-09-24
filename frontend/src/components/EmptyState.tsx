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
        <p>Pick a page on the left to see it next to its extracted text.</p>
      </div>
    )
  }
  return (
    <div className="empty-state">
      <FileUp size={40} strokeWidth={1.5} aria-hidden />
      <h2>Upload a PDF or an image</h2>
      <p>
        Every page becomes its own image. Press <ScanText size={14} className="inline-icon" aria-label="Extract" /> on a
        page to send it to an Ollama vision model, and compare the page with the extracted text side by side.
      </p>
      <UploadButton accept={accept} busy={busy} onFiles={onUpload} large />
      <p className="hint">or drop files anywhere in this window</p>
    </div>
  )
}
