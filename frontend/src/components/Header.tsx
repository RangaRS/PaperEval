import { Cloud, LoaderCircle, RefreshCw, Server, Settings } from 'lucide-react'

import type { ModelInfo, OllamaStatus } from '../api'
import { offeredNames, type ModelGroups } from '../models'

interface HeaderProps {
  status: OllamaStatus | null
  checking: boolean
  models: ModelGroups
  model: string
  onModelChange: (model: string) => void
  onAddModel: () => void
  onRefresh: () => void
  onOpenSettings: () => void
}

export function Header({
  status,
  checking,
  models,
  model,
  onModelChange,
  onAddModel,
  onRefresh,
  onOpenSettings,
}: HeaderProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <img src="/favicon.svg" alt="" width={26} height={26} />
        <span className="brand-name">PaperEval</span>
        <span className="brand-tagline">OCR with Ollama vision models</span>
      </div>
      <div className="topbar-controls">
        <ConnectionBadge status={status} checking={checking} onRefresh={onRefresh} />
        <ModelPicker groups={models} value={model} onChange={onModelChange} onAddModel={onAddModel} />
        <button type="button" className="icon-btn" onClick={onOpenSettings} title="Settings" aria-label="Settings">
          <Settings size={18} />
        </button>
      </div>
    </header>
  )
}

/** Whether the Ollama server runs on this computer. */
function isLocal(url: string | undefined): boolean {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url ?? '').hostname)
  } catch {
    return false
  }
}

function ConnectionBadge({
  status,
  checking,
  onRefresh,
}: {
  status: OllamaStatus | null
  checking: boolean
  onRefresh: () => void
}) {
  const connected = status?.reachable ?? false
  const name = status?.cloud ? 'Ollama Cloud' : isLocal(status?.base_url) ? 'Local Ollama' : 'Ollama'
  const label = status === null ? 'Connecting…' : connected ? name : `${name} not connected`
  const Icon = status?.cloud ? Cloud : Server
  const detail = status ? `${status.base_url}${status.error ? `\n${status.error}` : ''}` : ''
  return (
    <button
      type="button"
      className={`connection${connected ? ' is-connected' : status ? ' is-disconnected' : ''}`}
      onClick={onRefresh}
      title={`${detail}\nClick to check again.`.trim()}
    >
      <span className="connection-dot" aria-hidden />
      <Icon size={15} aria-hidden />
      <span className="connection-label">{label}</span>
      {checking ? <LoaderCircle size={14} className="spin" aria-hidden /> : <RefreshCw size={13} aria-hidden />}
    </button>
  )
}

// The value of the "Add a model…" entry. Added names are trimmed, so none can start with a space.
const ADD_MODEL = ' add a model'

function ModelPicker({
  groups,
  value,
  onChange,
  onAddModel,
}: {
  groups: ModelGroups
  value: string
  onChange: (model: string) => void
  onAddModel: () => void
}) {
  const option = (model: ModelInfo) => (
    <option key={model.name} value={model.name}>
      {model.name}
      {model.parameter_size && !model.name.includes(model.parameter_size.toLowerCase())
        ? ` · ${model.parameter_size}`
        : ''}
    </option>
  )
  return (
    <label className="model-picker" title="The Ollama model that reads the pages">
      <span className="model-picker-label">Model</span>
      <select
        value={value}
        onChange={(event) => (event.target.value === ADD_MODEL ? onAddModel() : onChange(event.target.value))}
      >
        {!value && <option value="">Choose a model</option>}
        {value && !offeredNames(groups).includes(value) && <option value={value}>{value}</option>}
        {groups.vision.length > 0 && <optgroup label="Vision models">{groups.vision.map(option)}</optgroup>}
        {groups.unknown.length > 0 && (
          <optgroup label={groups.vision.length > 0 ? 'Other models (image support unknown)' : 'Models'}>
            {groups.unknown.map(option)}
          </optgroup>
        )}
        {groups.added.length > 0 && (
          <optgroup label="Added by you">
            {groups.added.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </optgroup>
        )}
        <option value={ADD_MODEL}>+ Add a model…</option>
      </select>
    </label>
  )
}
