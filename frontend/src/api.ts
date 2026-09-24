import { readNdjson } from './ndjson'

export interface OcrResult {
  text: string
  model: string
  prompt: string
  created_at: string
  duration_ms: number
  truncated: boolean
  prompt_tokens: number | null
  output_tokens: number | null
}

export interface Page {
  number: number
  width: number
  height: number
  image_url: string
  thumbnail_url: string
  ocr: OcrResult | null
}

export interface DocumentInfo {
  id: string
  filename: string
  kind: 'pdf' | 'image'
  created_at: string
  pages: Page[]
}

export interface ModelInfo {
  name: string
  size: number | null
  parameter_size: string | null
  family: string | null
  /** Whether the model reads images; null when the server does not say. */
  vision: boolean | null
  cloud: boolean
}

export interface OllamaStatus {
  base_url: string
  cloud: boolean
  api_key_configured: boolean
  reachable: boolean
  version: string | null
  error: string | null
  models: ModelInfo[]
}

export interface PromptPreset {
  id: string
  label: string
  prompt: string
}

export interface AppConfig {
  default_model: string
  default_prompt: string
  prompt_presets: PromptPreset[]
  max_upload_mb: number
  max_pages: number
  accepted_extensions: string[]
}

/** Progress events streamed while a page is being read. */
export type OcrEvent =
  | { type: 'start'; model: string }
  | { type: 'thinking' }
  | { type: 'chunk'; text: string }
  | { type: 'done'; result: OcrResult }
  | { type: 'error'; message: string }

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function errorFrom(response: Response): Promise<ApiError> {
  let message = `${response.status} ${response.statusText}`.trim()
  try {
    const body: unknown = await response.json()
    const detail = (body as { detail?: unknown }).detail
    if (typeof detail === 'string') message = detail
    else if (Array.isArray(detail) && detail.length > 0) message = String(detail[0]?.msg ?? message)
  } catch {
    // Not JSON: keep the status text.
  }
  return new ApiError(message, response.status)
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, init)
  } catch {
    throw new ApiError('Could not reach the PaperEval server. Is the backend running?', 0)
  }
  if (!response.ok) throw await errorFrom(response)
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export const api = {
  config: () => request<AppConfig>('/api/config'),

  ollamaStatus: () => request<OllamaStatus>('/api/ollama'),

  listDocuments: () => request<DocumentInfo[]>('/api/documents'),

  uploadDocument(file: File): Promise<DocumentInfo> {
    const form = new FormData()
    form.append('file', file)
    return request<DocumentInfo>('/api/documents', { method: 'POST', body: form })
  },

  deleteDocument: (documentId: string) => request<void>(`/api/documents/${documentId}`, { method: 'DELETE' }),

  /** Ask the model to read one page, yielding progress events as they arrive. */
  async *extractText(
    documentId: string,
    pageNumber: number,
    options: { model: string; prompt: string },
    signal?: AbortSignal,
  ): AsyncGenerator<OcrEvent> {
    const response = await fetch(`/api/documents/${documentId}/pages/${pageNumber}/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
      signal,
    })
    if (!response.ok) throw await errorFrom(response)
    if (!response.body) throw new ApiError('The server sent an empty response.', response.status)
    yield* readNdjson<OcrEvent>(response.body)
  },
}
