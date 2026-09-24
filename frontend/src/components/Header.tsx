import { Cloud, LoaderCircle, RefreshCw, Server, Settings } from 'lucide-react'

import type { ModelInfo, OllamaStatus } from '../api'

interface HeaderProps {
  status: OllamaStatus | null
  checking: boolean
  models: ModelInfo[]
  model: string
  onModelChange: (model: string) => void
  onRefresh: () => void
  onOpenSettings: () => void
}

export function Header({ status, checking, models, model, onModelChange, onRefresh, onOpenSettings }: HeaderProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <img src="/favicon.svg" alt="" width={26} height={26} />
        <span className="brand-name">PaperEval</span>
        <span className="brand-tagline">OCR with Ollama vision models</span>
      </div>
      <div className="topbar-controls">
        <ConnectionBadge status={status} checking={checking} onRefresh={onRefresh} />
        <ModelPicker models={models} value={model} onChange={onModelChange} disabled={!status?.reachable} />
        <button type="button" className="icon-btn" onClick={onOpenSettings} title="Settings" aria-label="Settings">
          <Settings size={18} />
        </button>
      </div>
    </header>
  )
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
  const name = status?.cloud ? 'Ollama Cloud' : 'Ollama'
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

function ModelPicker({
  models,
  value,
  onChange,
  disabled,
}: {
  models: ModelInfo[]
  value: string
  onChange: (model: string) => void
  disabled: boolean
}) {
  const vision = models.filter((model) => model.vision === true)
  const unknown = models.filter((model) => model.vision === null)
  const listed = [...vision, ...unknown].some((model) => model.name === value)
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
      <select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled && !value}>
        {!value && <option value="">No vision model found</option>}
        {value && !listed && <option value={value}>{value}</option>}
        {vision.length > 0 && <optgroup label="Vision models">{vision.map(option)}</optgroup>}
        {unknown.length > 0 && (
          <optgroup label={vision.length > 0 ? 'Other models (image support unknown)' : 'Models'}>
            {unknown.map(option)}
          </optgroup>
        )}
      </select>
    </label>
  )
}
