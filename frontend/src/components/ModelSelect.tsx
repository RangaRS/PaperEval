import type { ModelInfo } from '../api'

/** Every model the server offers, whether or not it reads images, plus the ones added by name. */
export function ModelSelect({
  id,
  value,
  onChange,
  models,
  added,
}: {
  id?: string
  value: string
  onChange: (model: string) => void
  models: ModelInfo[]
  added: string[]
}) {
  const listed = models.map((model) => model.name)
  const extra = [...new Set(added.map((name) => name.trim()).filter((name) => name && !listed.includes(name)))]
  const known = [...listed, ...extra]
  return (
    <select id={id} className="select" value={value} onChange={(event) => onChange(event.target.value)}>
      {!value && <option value="">Choose a model</option>}
      {value && !known.includes(value) && <option value={value}>{value}</option>}
      {listed.length > 0 && (
        <optgroup label="Models">
          {models.map((model) => (
            <option key={model.name} value={model.name}>
              {model.name}
            </option>
          ))}
        </optgroup>
      )}
      {extra.length > 0 && (
        <optgroup label="Added by you">
          {extra.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  )
}
