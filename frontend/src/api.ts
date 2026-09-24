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

export interface Question {
  id: string
  /** The question's label as printed, e.g. "1" or "11 (a)". */
  number: string
  question: string
  /** The model answer. */
  answer: string
  /** The marking scheme. */
  key: string
  max_marks: number
}

/** An answer key: an exam's questions with their model answers, marking keys and marks. */
export interface Exam {
  id: string
  name: string
  created_at: string
  updated_at: string
  questions: Question[]
  total_marks: number
}

export interface ExamSummary {
  id: string
  name: string
  created_at: string
  updated_at: string
  question_count: number
  total_marks: number
  /** Questions without marks, which need them before scripts can be evaluated. */
  unmarked_questions: string[]
}

export interface ExamDraft {
  name: string
  questions: Question[]
}

export type AnswerStatus = 'pending' | 'graded' | 'unanswered' | 'error'

export interface EvaluatedAnswer {
  question_id: string
  number: string
  max_marks: number
  /** The student's answer, as found in the script. */
  answer: string
  pages: number[]
  status: AnswerStatus
  ai_marks: number | null
  feedback: string
  error: string | null
  model: string | null
  graded_at: string | null
  teacher_marks: number | null
  /** The marks that count: the teacher's, else the AI's. Null while not marked. */
  marks: number | null
}

/** A student's script split into answers, each marked against an answer key. */
export interface Evaluation {
  id: string
  document_id: string
  document_name: string
  exam_id: string
  exam_name: string
  model: string
  created_at: string
  updated_at: string
  student_name: string
  roll_number: string
  answers: EvaluatedAnswer[]
  marks: number
  max_marks: number
  complete: boolean
}

export interface AnswerSummary {
  question_id: string
  number: string
  status: AnswerStatus
  marks: number | null
  max_marks: number
}

export interface EvaluationSummary extends Omit<Evaluation, 'answers'> {
  answers: AnswerSummary[]
}

/** Progress events streamed while a script is evaluated or its answers are marked. */
export type EvaluationEvent =
  | { type: 'status'; step: 'split' }
  | { type: 'split'; evaluation: Evaluation }
  | { type: 'answer'; answer: EvaluatedAnswer }
  | { type: 'done'; evaluation: Evaluation }
  | { type: 'error'; message: string }

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

const jsonBody = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

async function* streamEvents<T>(path: string, body: unknown, signal?: AbortSignal): AsyncGenerator<T> {
  let response: Response
  try {
    response = await fetch(path, { ...jsonBody(body), signal })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new ApiError('Could not reach the PaperEval server. Is the backend running?', 0)
  }
  if (!response.ok) throw await errorFrom(response)
  if (!response.body) throw new ApiError('The server sent an empty response.', response.status)
  yield* readNdjson<T>(response.body)
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, init)
  } catch (error) {
    if (init?.signal?.aborted) throw error
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
  extractText: (
    documentId: string,
    pageNumber: number,
    options: { model: string; prompt: string },
    signal?: AbortSignal,
  ) => streamEvents<OcrEvent>(`/api/documents/${documentId}/pages/${pageNumber}/ocr`, options, signal),

  listExams: () => request<ExamSummary[]>('/api/exams'),

  getExam: (examId: string) => request<Exam>(`/api/exams/${examId}`),

  createExam: (draft: ExamDraft) => request<Exam>('/api/exams', jsonBody(draft)),

  updateExam: (examId: string, draft: ExamDraft) => request<Exam>(`/api/exams/${examId}`, jsonBody(draft, 'PUT')),

  deleteExam: (examId: string) => request<void>(`/api/exams/${examId}`, { method: 'DELETE' }),

  /** Have a model read an answer key from a document whose text has been extracted. */
  examFromDocument: (options: { document_id: string; model: string }, signal?: AbortSignal) =>
    request<Exam>('/api/exams/from-document', { ...jsonBody(options), signal }),

  /** Every evaluated script's marks, as a CSV spreadsheet. */
  async resultsCsv(examId: string): Promise<Blob> {
    let response: Response
    try {
      response = await fetch(`/api/exams/${examId}/results.csv`)
    } catch {
      throw new ApiError('Could not reach the PaperEval server. Is the backend running?', 0)
    }
    if (!response.ok) throw await errorFrom(response)
    return response.blob()
  },

  listEvaluations: () => request<EvaluationSummary[]>('/api/evaluations'),

  getEvaluation: (evaluationId: string) => request<Evaluation>(`/api/evaluations/${evaluationId}`),

  changeEvaluation: (evaluationId: string, changes: { student_name?: string; roll_number?: string }) =>
    request<Evaluation>(`/api/evaluations/${evaluationId}`, jsonBody(changes, 'PATCH')),

  deleteEvaluation: (evaluationId: string) => request<void>(`/api/evaluations/${evaluationId}`, { method: 'DELETE' }),

  /** Correct an answer's text, or give it the teacher's marks (null goes back to the AI's). */
  changeAnswer: (
    evaluationId: string,
    questionId: string,
    changes: { answer?: string; teacher_marks?: number | null },
  ) => request<Evaluation>(`/api/evaluations/${evaluationId}/answers/${questionId}`, jsonBody(changes, 'PATCH')),

  /** Evaluate a script against an answer key, yielding progress events as they arrive. */
  evaluate: (documentId: string, options: { exam_id: string; model: string }, signal?: AbortSignal) =>
    streamEvents<EvaluationEvent>(`/api/documents/${documentId}/evaluations`, options, signal),

  /** Mark the given answers again, or else every answer without marks. */
  grade: (evaluationId: string, options: { model: string; question_ids?: string[] }, signal?: AbortSignal) =>
    streamEvents<EvaluationEvent>(`/api/evaluations/${evaluationId}/grade`, options, signal),
}
