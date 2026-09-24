import { LoaderCircle, Upload } from 'lucide-react'
import { useRef } from 'react'

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

/**
 * A large area with a title, an explanation and an upload button, or with `compact`, a single row.
 * Files dropped on the window also land here.
 */
export function UploadZone({
  title,
  hint,
  accept,
  busy,
  multiple = false,
  compact = false,
  label,
  onFiles,
}: {
  title: string
  hint: string
  accept: string[]
  busy: boolean
  multiple?: boolean
  compact?: boolean
  label: string
  onFiles: (files: File[]) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const drop = <p className="hint">or drop {multiple ? 'files' : 'the file'} anywhere in this window</p>
  const button = (
    <button type="button" className="btn btn-primary" onClick={() => input.current?.click()} disabled={busy}>
      {busy ? <LoaderCircle size={16} className="spin" aria-hidden /> : <Upload size={16} aria-hidden />}
      {label}
    </button>
  )
  return (
    <div className={`upload-zone${compact ? ' is-compact' : ''}`}>
      <Upload size={compact ? 20 : 28} strokeWidth={1.5} aria-hidden />
      {compact ? (
        <>
          <div className="upload-zone-text">
            <p className="upload-zone-title">{title}</p>
            {drop}
          </div>
          {button}
        </>
      ) : (
        <>
          <p className="upload-zone-title">{title}</p>
          <p className="hint">{hint}</p>
          {button}
          {drop}
        </>
      )}
      <input
        ref={input}
        type="file"
        multiple={multiple}
        hidden
        accept={['application/pdf', 'image/*', ...accept].join(',')}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          event.target.value = ''
          if (files.length > 0) onFiles(files)
        }}
      />
    </div>
  )
}
