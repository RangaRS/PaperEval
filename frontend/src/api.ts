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

/** What a document is to its evaluator: the question paper with the key, or a student's answer paper. */
export type DocumentRole = 'key' | 'script'

export interface DocumentInfo {
  id: string
  filename: string
  kind: 'pdf' | 'image'
  created_at: string
  pages: Page[]
  /** The evaluator the document belongs to, if any. */
  exam_id: string | null
  role: DocumentRole | null
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

/** A question's place in the paper. */
export interface QuestionRef {
  kind: 'question'
  question_id: string
}

/** A section, a question with sub-parts, or a choice: questions and groups with a rule saying which of them count. */
export interface PaperGroup {
  kind: 'group'
  id: string
  /** Its name as printed, e.g. "Part B" or "11". */
  label: string
  /** Its instructions, or text its questions share. */
  text: string
  /** `all`: every child counts. `any`: the best `count` of them count. */
  rule: 'all' | 'any'
  count: number
  /** For `any`: pool the children of each child group, taking at least this many from each. 0 for none. */
  min_each: number
  /** The most marks the group can give; 0 for no limit. */
  cap: number
  children: PaperNode[]
}

export type PaperNode = PaperGroup | QuestionRef

/** An evaluator: an exam's questions with their model answers, marking keys and marks. */
export interface Exam {
  id: string
  name: string
  created_at: string
  updated_at: string
  questions: Question[]
  /** How the questions are grouped into sections, sub-parts and choices. */
  structure: PaperGroup
  /** The most marks the paper can give, counting only as many choices as a student may make. */
  total_marks: number
  /** The uploaded question paper with its answers and marking scheme. */
  key_document_id: string | null
  /** The subject and exam sitting this is the paper of, when it is part of the college's structure. */
  subject_id: string | null
  sitting_id: string | null
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
  key_document_id: string | null
  subject_id: string | null
  sitting_id: string | null
}

/** Where an evaluator belongs: a subject's paper in an exam sitting, or neither (both null). */
export interface Placement {
  subject_id: string | null
  sitting_id: string | null
}

export type TermType = 'semester' | 'year'
export type SittingKind = 'internal' | 'model' | 'end_term' | 'supplementary' | 'other'

export interface Department {
  id: string
  name: string
  code: string
}

export interface Programme {
  id: string
  department_id: string
  name: string
  code: string
  /** Taught in semesters or in years, and how many. */
  term_type: TermType
  term_count: number
}

export interface Subject {
  id: string
  programme_id: string
  /** The semester (or year) of the programme it is taught in, from 1. */
  term: number
  code: string
  name: string
}

/** An exam sitting across the college, such as "Nov/Dec 2026" or "Internal test 1". */
export interface Sitting {
  id: string
  name: string
  kind: SittingKind
  academic_year: string
}

/** The college's structure: departments, their programmes, the subjects of each term, and exam sittings. */
export interface Catalog {
  institution: { name: string }
  departments: Department[]
  programmes: Programme[]
  subjects: Subject[]
  sittings: Sitting[]
}

export type CatalogCollection = 'departments' | 'programmes' | 'subjects' | 'sittings'
export type CatalogItemIn<C extends CatalogCollection> = Omit<Catalog[C][number], 'id'>

export interface ExamDraft {
  name: string
  questions: Question[]
  structure: PaperGroup
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
  /** The answer key's sections and choices, which say which answers count. */
  structure: PaperGroup
  marks: number
  max_marks: number
  complete: boolean
  /** Questions whose marks do not count, because the student's other choices gave more. */
  not_counted: string[]
}

export interface AnswerSummary {
  question_id: string
  number: string
  status: AnswerStatus
  marks: number | null
  max_marks: number
}

export interface EvaluationSummary extends Omit<Evaluation, 'answers' | 'structure'> {
  answers: AnswerSummary[]
}

/** Progress events streamed while a script is evaluated or its answers are marked. */
export type EvaluationEvent =
  | { type: 'status'; step: 'split' }
  /** How much of its answer the model has written; attempt 2 is a second try without a fixed format. */
  | { type: 'progress'; step: 'split'; attempt: number; characters: number }
  | { type: 'split'; evaluation: Evaluation }
  | { type: 'answer'; answer: EvaluatedAnswer }
  | { type: 'done'; evaluation: Evaluation }
  /** `reply` is the model's answer, when it could not be used. */
  | { type: 'error'; message: string; reply?: string }

/** Progress events streamed while a model reads an answer key from a document's text. */
export type AnswerKeyEvent =
  | { type: 'start'; model: string; pages: number; characters: number }
  | { type: 'progress'; attempt: number; characters: number }
  | { type: 'done'; exam: Exam }
  | { type: 'error'; message: string; reply?: string }

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

  /** Upload a PDF or image, optionally into an evaluator as its key file or as an answer paper. */
  uploadDocument(file: File, to?: { examId: string; role: DocumentRole }): Promise<DocumentInfo> {
    const form = new FormData()
    form.append('file', file)
    if (to) {
      form.append('exam_id', to.examId)
      form.append('role', to.role)
    }
    return request<DocumentInfo>('/api/documents', { method: 'POST', body: form })
  },

  /** Put an uploaded document into an evaluator, or (with nulls) take it out. */
  assignDocument: (documentId: string, to: { exam_id: string | null; role: DocumentRole | null }) =>
    request<DocumentInfo>(`/api/documents/${documentId}`, jsonBody(to, 'PATCH')),

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

  createExam: (draft: Omit<ExamDraft, 'structure'> & Partial<Pick<ExamDraft, 'structure'>> & Partial<Placement>) => request<Exam>('/api/exams', jsonBody(draft)),

  /** Make an evaluator a subject's paper in an exam sitting, or (with nulls) take it out of the structure. */
  placeExam: (examId: string, placement: Placement) =>
    request<Exam>(`/api/exams/${examId}/placement`, jsonBody(placement, 'PATCH')),

  getCatalog: () => request<Catalog>('/api/catalog'),

  setInstitution: (name: string) => request<Catalog>('/api/catalog/institution', jsonBody({ name }, 'PUT')),

  addCatalogItem: <C extends CatalogCollection>(collection: C, item: CatalogItemIn<C>) =>
    request<Catalog>(`/api/catalog/${collection}`, jsonBody(item)),

  updateCatalogItem: <C extends CatalogCollection>(collection: C, id: string, item: CatalogItemIn<C>) =>
    request<Catalog>(`/api/catalog/${collection}/${id}`, jsonBody(item, 'PUT')),

  deleteCatalogItem: (collection: CatalogCollection, id: string) =>
    request<Catalog>(`/api/catalog/${collection}/${id}`, { method: 'DELETE' }),

  /** Fill an empty structure with a made-up college. */
  loadSampleCatalog: () => request<Catalog>('/api/catalog/sample', { method: 'POST' }),

  updateExam: (examId: string, draft: ExamDraft) => request<Exam>(`/api/exams/${examId}`, jsonBody(draft, 'PUT')),

  deleteExam: (examId: string) => request<void>(`/api/exams/${examId}`, { method: 'DELETE' }),

  /** Have a model read an evaluator's questions from its key file, whose text has been extracted. */
  readKey: (examId: string, options: { model: string }, signal?: AbortSignal) =>
    streamEvents<AnswerKeyEvent>(`/api/exams/${examId}/read-key`, options, signal),

  /** Have a model read an answer key from a document whose text has been extracted, yielding its progress. */
  examFromDocument: (options: { document_id: string; model: string }, signal?: AbortSignal) =>
    streamEvents<AnswerKeyEvent>('/api/exams/from-document', options, signal),

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
