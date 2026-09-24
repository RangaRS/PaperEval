import { X } from 'lucide-react'
import { useEffect, useId, useRef, type ReactNode } from 'react'

interface DialogProps {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  /** Buttons at the bottom of the dialog. */
  footer?: ReactNode
  /** Keep the dialog open when Escape is pressed or the backdrop is clicked, e.g. while it is busy. */
  locked?: boolean
  wide?: boolean
}

/** A modal dialog, using the browser's <dialog> element. */
export function Dialog({ open, title, onClose, children, footer, locked = false, wide = false }: DialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open && !element.open) element.showModal()
    if (!open && element.open) element.close()
  }, [open])

  return (
    <dialog
      ref={dialog}
      className={`dialog${wide ? ' dialog-wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        // Escape: let the parent decide, so its state stays in step with the dialog.
        event.preventDefault()
        if (!locked) onClose()
      }}
      onClick={(event) => event.target === event.currentTarget && !locked && onClose()}
    >
      {open && (
        <div className="dialog-content">
          <header className="dialog-header">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="icon-btn" onClick={onClose} disabled={locked} aria-label="Close">
              <X size={18} />
            </button>
          </header>
          <div className="dialog-body">{children}</div>
          {footer && <footer className="dialog-footer">{footer}</footer>}
        </div>
      )}
    </dialog>
  )
}
