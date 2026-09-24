import { CircleAlert, Info, X } from 'lucide-react'

export interface Toast {
  id: number
  kind: 'error' | 'info'
  message: string
}

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
          {toast.kind === 'error' ? <CircleAlert size={16} aria-hidden /> : <Info size={16} aria-hidden />}
          <span className="toast-message">{toast.message}</span>
          <button type="button" className="icon-btn" onClick={() => onDismiss(toast.id)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
