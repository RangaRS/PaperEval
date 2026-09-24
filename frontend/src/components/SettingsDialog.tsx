import { X } from 'lucide-react'
import { useEffect, useRef } from 'react'

import type { AppConfig, OllamaStatus } from '../api'

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
  config: AppConfig | null
  status: OllamaStatus | null
  prompt: string
  onPromptChange: (prompt: string) => void
}

export function SettingsDialog({ open, onClose, config, status, prompt, onPromptChange }: SettingsDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open && !element.open) element.showModal()
    if (!open && element.open) element.close()
  }, [open])

  const presets = config?.prompt_presets ?? []
  const activePreset = presets.find((preset) => preset.prompt === prompt)

  return (
    <dialog
      ref={dialog}
      className="dialog"
      onClose={onClose}
      onClick={(event) => event.target === event.currentTarget && onClose()}
      aria-labelledby="settings-title"
    >
      <div className="dialog-content">
        <header className="dialog-header">
          <h2 id="settings-title">Settings</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close settings">
            <X size={18} />
          </button>
        </header>

        <section className="dialog-section">
          <h3>Prompt</h3>
          <p className="hint">Sent to the model together with each page image.</p>
          <div className="segmented" role="group" aria-label="Prompt presets">
            {presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={preset === activePreset ? 'is-active' : undefined}
                aria-pressed={preset === activePreset}
                onClick={() => onPromptChange(preset.prompt)}
              >
                {preset.label}
              </button>
            ))}
            <button type="button" className={activePreset ? undefined : 'is-active'} aria-pressed={!activePreset} disabled>
              Custom
            </button>
          </div>
          <textarea
            className="prompt-input"
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            rows={8}
            spellCheck={false}
            aria-label="Prompt"
          />
          <div className="dialog-row">
            <span className="hint">Saved in this browser. Applies to pages you extract from now on.</span>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => config && onPromptChange(config.default_prompt)}
              disabled={!config || prompt === config.default_prompt}
            >
              Reset to default
            </button>
          </div>
        </section>

        <section className="dialog-section">
          <h3>Ollama connection</h3>
          {status ? (
            <dl className="details">
              <dt>Server</dt>
              <dd>
                {status.cloud ? 'Ollama Cloud' : 'Ollama'} at <code>{status.base_url}</code>
              </dd>
              <dt>API key</dt>
              <dd>{status.api_key_configured ? 'Configured' : 'Not set'}</dd>
              <dt>Status</dt>
              <dd>
                {status.reachable
                  ? `Connected${status.version ? `, version ${status.version}` : ''}`
                  : `Not connected. ${status.error ?? ''}`}
              </dd>
              {status.reachable && (
                <>
                  <dt>Models</dt>
                  <dd>
                    {status.models.filter((model) => model.vision === true).length} with vision support,{' '}
                    {status.models.length} in total
                  </dd>
                </>
              )}
            </dl>
          ) : (
            <p className="hint">Checking the connection…</p>
          )}
          <p className="hint">
            The server and API key are set on the backend with the <code>OLLAMA_BASE_URL</code> and{' '}
            <code>OLLAMA_API_KEY</code> environment variables. The key never reaches the browser.
          </p>
        </section>
      </div>
    </dialog>
  )
}
