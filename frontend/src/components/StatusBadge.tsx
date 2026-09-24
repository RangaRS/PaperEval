import { CircleAlert, CircleCheck, CircleDashed, CircleStop, Clock, LoaderCircle } from 'lucide-react'

import type { PageStatus } from '../ocrQueue'

const BADGES: Record<PageStatus, { label: string; icon: typeof Clock }> = {
  idle: { label: 'Not extracted', icon: CircleDashed },
  queued: { label: 'Queued', icon: Clock },
  running: { label: 'Extracting…', icon: LoaderCircle },
  done: { label: 'Extracted', icon: CircleCheck },
  error: { label: 'Failed', icon: CircleAlert },
  stopped: { label: 'Stopped', icon: CircleStop },
}

export function StatusBadge({ status }: { status: PageStatus }) {
  const { label, icon: Icon } = BADGES[status]
  return (
    <span className={`badge badge-${status}`}>
      <Icon size={13} className={status === 'running' ? 'spin' : undefined} aria-hidden />
      {label}
    </span>
  )
}
