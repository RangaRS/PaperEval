import { CalendarDays, CloudOff, FileUp, FolderInput, RefreshCw, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import {
  api,
  type AppConfig,
  type Catalog,
  type DocumentInfo,
  type DocumentRole,
  type Evaluation,
  type EvaluationSummary,
  type Exam,
  type ExamSummary,
  type OllamaStatus,
  type Placement,
} from './api'
import {
  currentSitting,
  emptyCatalog,
  hasStructure,
  paperOf,
  pathTo,
  scopeTitle,
  SITTING_KINDS,
  subjectLabel,
  type Scope,
} from './college'
import { Breadcrumb } from './components/Breadcrumb'
import { CollegeNav, type NavSelection } from './components/CollegeNav'
import { EvaluationPanel } from './components/EvaluationPanel'
import { EvaluatorView } from './components/EvaluatorView'
import { Header } from './components/Header'
import { KeyStep } from './components/KeyStep'
import { Overview } from './components/Overview'
import { PapersStep } from './components/PapersStep'
import { PlacementDialog } from './components/PlacementDialog'
import { ResultsStep } from './components/ResultsStep'
import { SettingsDialog } from './components/SettingsDialog'
import { StructurePage } from './components/StructurePage'
import { SubjectPage } from './components/SubjectPage'
import { Toasts } from './components/Toasts'
import { Welcome } from './components/Welcome'
import { Workspace, type WorkspacePanel } from './components/Workspace'
import { EvaluationRunner, isRunning } from './evaluationRunner'
import { isKeyReading, keyProblem, paperState, summaryOf, type EvaluatorTab, type KeyRead } from './evaluator'
import { joinList, parseAnswerKey, summarize, withSummary } from './exams'
import { isBoolean, isString, isStringArray, useFileDrop, useLocalStorage, useToasts } from './hooks'
import { chooseModel, modelGroups, offeredNames } from './models'
import { OcrQueue, pageKey } from './ocrQueue'
import { errorMessage, fileStem, pluralize } from './utils'

const MB = 1024 * 1024
const isPrompt = (value: unknown): value is string | null => value === null || typeof value === 'string'
const isPanel = (value: unknown): value is WorkspacePanel => value === 'text' || value === 'marks'

/** What the main area shows. */
type View =
  | { kind: 'home' }
  /** How far every subject's paper has got, in a part of the college. */
  | { kind: 'overview'; scope: Scope }
  /** A subject that has no paper in the exam sitting yet. */
  | { kind: 'subject'; subjectId: string }
  /** Setting up the college's departments, programmes, subjects and exam sittings. */
  | { kind: 'structure' }
  | { kind: 'evaluator'; examId: string; tab: EvaluatorTab }
  /** A document of an evaluator, page by page: an answer paper with its marks, or the key file. */
  | { kind: 'document'; examId: string; documentId: string; pageNumber: number }

interface UploadProgress {
  examId: string
  role: DocumentRole
  name: string
  index: number
  total: number
}

/**
 * What to show: the chosen view, or when nothing was chosen yet (or what was chosen was deleted),
 * the evaluator used last. It opens on its answer papers once it has questions.
 */
function currentView(
  chosen: View | null,
  exams: ExamSummary[],
  documents: DocumentInfo[],
  catalog: Catalog,
  last: string,
): View {
  const structured = hasStructure(catalog)
  const overview: View = { kind: 'overview', scope: { kind: 'institution' } }
  const fallback = exams.find((exam) => exam.id === last) ?? (structured ? undefined : exams[0])
  const start: View = fallback
    ? { kind: 'evaluator', examId: fallback.id, tab: fallback.question_count > 0 ? 'papers' : 'key' }
    : structured
      ? overview
      : { kind: 'home' }
  if (!chosen) return start
  if (chosen.kind === 'home') return structured ? overview : chosen
  if (chosen.kind === 'structure') return chosen
  if (chosen.kind === 'subject') {
    return catalog.subjects.some((subject) => subject.id === chosen.subjectId) ? chosen : start
  }
  if (chosen.kind === 'overview') {
    const scope = chosen.scope
    const exists =
      scope.kind === 'institution' ||
      (scope.kind === 'department'
        ? catalog.departments.some((department) => department.id === scope.departmentId)
        : catalog.programmes.some((programme) => programme.id === scope.programmeId))
    return exists ? chosen : start
  }
  const examId = chosen.examId
  if (!exams.some((exam) => exam.id === examId)) return start
  if (chosen.kind === 'document' && !documents.some((document) => document.id === chosen.documentId)) {
    return { kind: 'evaluator', examId, tab: 'papers' }
  }
  return chosen
}

/** An evaluator's answer papers, in the order they were uploaded (and are marked). */
function papersOf(documents: DocumentInfo[], examId: string) {
  return documents
    .filter((document) => document.exam_id === examId && document.role === 'script')
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
}

function withPageText(
  documents: DocumentInfo[],
  documentId: string,
  pageNumber: number,
  ocr: DocumentInfo['pages'][number]['ocr'],
) {
  return documents.map((document) =>
    document.id !== documentId
      ? document
      : { ...document, pages: document.pages.map((page) => (page.number === pageNumber ? { ...page, ocr } : page)) },
  )
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [status, setStatus] = useState<OllamaStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [focusModelInput, setFocusModelInput] = useState(false)
  const [savedModel, setSavedModel] = useLocalStorage('papereval.model', '', isString)
  const [addedModels, setAddedModels] = useLocalStorage<string[]>('papereval.addedModels', [], isStringArray)
  const [customPrompt, setCustomPrompt] = useLocalStorage<string | null>('papereval.prompt', null, isPrompt)
  const [savedGradingModel, setSavedGradingModel] = useLocalStorage('papereval.gradingModel', '', isString)
  const [panel, setPanel] = useLocalStorage<WorkspacePanel>('papereval.panel', 'marks', isPanel)
  const [answerPreview, setAnswerPreview] = useLocalStorage('papereval.answerPreview', true, isBoolean)
  const [lastEvaluator, setLastEvaluator] = useLocalStorage('papereval.evaluator', '', isString)
  const [chosenSitting, setChosenSitting] = useLocalStorage('papereval.sitting', '', isString)
  const [expanded, setExpanded] = useLocalStorage<string[]>('papereval.expanded', [], isStringArray)
  const { toasts, notify, dismiss: dismissToast } = useToasts()

  const [documents, setDocuments] = useState<DocumentInfo[]>([])
  const [exams, setExams] = useState<ExamSummary[]>([])
  const [evaluations, setEvaluations] = useState<EvaluationSummary[]>([])
  const [catalog, setCatalog] = useState<Catalog>(emptyCatalog)
  const [placingExamId, setPlacingExamId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [details, setDetails] = useState<Record<string, Evaluation>>({})
  const [examDetails, setExamDetails] = useState<Record<string, Exam>>({})
  const [keyReads, setKeyReads] = useState<Record<string, KeyRead>>({})
  const [chosenView, setChosenView] = useState<View | null>(null)
  const [upload, setUpload] = useState<UploadProgress | null>(null)
  // Whether the evaluator being edited has unsaved changes.
  const editorDirty = useRef(false)

  // The documents, kept up to date at once, for work that starts right after a change (such as an upload).
  const documentsRef = useRef<DocumentInfo[]>([])
  const updateDocuments = useCallback((change: (current: DocumentInfo[]) => DocumentInfo[]) => {
    documentsRef.current = change(documentsRef.current)
    setDocuments(documentsRef.current)
  }, [])

  const [queue] = useState(
    () =>
      new OcrQueue({
        run: (job, signal) =>
          api.extractText(job.documentId, job.pageNumber, { model: job.model, prompt: job.prompt }, signal),
        onResult: (job, result) =>
          updateDocuments((current) => withPageText(current, job.documentId, job.pageNumber, result)),
      }),
  )
  const jobs = useSyncExternalStore(queue.subscribe, queue.getSnapshot)
  useEffect(() => () => queue.cancelAll(() => true), [queue])

  const storeEvaluation = useCallback((evaluation: Evaluation) => {
    setDetails((current) => ({ ...current, [evaluation.id]: evaluation }))
    setEvaluations((current) => withSummary(current, summarize(evaluation)))
  }, [])

  const [runner] = useState(
    () =>
      new EvaluationRunner({
        // Replaced by prepareDocument once it is defined.
        prepare: () => Promise.resolve(),
        evaluate: (request, signal) =>
          api.evaluate(request.documentId, { exam_id: request.examId, model: request.model }, signal),
        grade: (request, signal) =>
          api.grade(request.evaluation.id, { model: request.model, question_ids: request.questionIds }, signal),
        onEvaluation: storeEvaluation,
      }),
  )
  const runs = useSyncExternalStore(runner.subscribe, runner.getSnapshot)
  useEffect(() => () => runner.stopAll(), [runner])

  useEffect(() => {
    api
      .config()
      .then(setConfig)
      .catch((error) => notify(errorMessage(error)))
    Promise.all([api.listDocuments(), api.listExams(), api.listEvaluations(), api.getCatalog()])
      .then(([loadedDocuments, loadedExams, loadedEvaluations, loadedCatalog]) => {
        updateDocuments(() => loadedDocuments)
        setExams(loadedExams)
        setEvaluations(loadedEvaluations)
        setCatalog(loadedCatalog)
      })
      .catch((error) => notify(`Could not load your evaluators: ${errorMessage(error)}`))
      .finally(() => setLoading(false))
  }, [notify, updateDocuments])

  const lastCheck = useRef(0)
  const loadStatus = useCallback(() => {
    lastCheck.current = Date.now()
    api
      .ollamaStatus()
      .then(setStatus)
      .catch((error) =>
        setStatus({
          base_url: '',
          cloud: false,
          api_key_configured: false,
          reachable: false,
          version: null,
          error: errorMessage(error),
          models: [],
        }),
      )
      .finally(() => setChecking(false))
  }, [])

  const refreshStatus = useCallback(() => {
    setChecking(true)
    loadStatus()
  }, [loadStatus])

  // Check the connection on start, and again when coming back to the tab (e.g. after pulling a model).
  useEffect(() => {
    loadStatus()
    const onFocus = () => {
      if (Date.now() - lastCheck.current > 15_000) refreshStatus()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [loadStatus, refreshStatus])

  const configuredModel = config?.default_model ?? ''
  // The configured default (OLLAMA_MODEL) is always offered, even if the server does not list it.
  const groups = useMemo(
    () => modelGroups(status?.models ?? [], [...addedModels, configuredModel]),
    [status, addedModels, configuredModel],
  )
  // The vision model that reads the pages.
  const model = chooseModel(savedModel, configuredModel, groups, (status?.models.length ?? 0) > 0)
  const prompt = customPrompt ?? config?.default_prompt ?? ''
  const setPrompt = (value: string) => setCustomPrompt(value === config?.default_prompt ? null : value)
  // Marking needs no images, so any model will do; it defaults to the one that reads the pages.
  const gradingModel = savedGradingModel || model
  const allModels = status?.models ?? []
  const extraModels = useMemo(() => [...addedModels, configuredModel].filter(Boolean), [addedModels, configuredModel])

  /**
   * Extract the text of a document's pages one by one: the pages that have none,
   * or with `all`, every page. Resolves when they are done; rejects if any failed.
   */
  const prepareDocument = useCallback(
    async (documentId: string, signal: AbortSignal, options?: { all?: boolean }) => {
      const document = documentsRef.current.find((candidate) => candidate.id === documentId)
      if (!document) throw new Error('The document was deleted.')
      const missing = document.pages.filter((page) => options?.all || !page.ocr).map((page) => page.number)
      if (missing.length === 0) return
      if (!model) throw new Error('Choose a reading model at the top: it reads the text of the pages.')
      for (const pageNumber of missing) queue.enqueue({ documentId, pageNumber, model, prompt })
      const keys = missing.map((pageNumber) => pageKey(documentId, pageNumber))
      const stop = () => queue.cancelAll((job) => keys.includes(job.key))
      signal.addEventListener('abort', stop)
      try {
        await queue.settled(keys, signal)
      } finally {
        signal.removeEventListener('abort', stop)
      }
      const failed = missing.filter(
        (pageNumber) => queue.getSnapshot().get(pageKey(documentId, pageNumber))?.status !== 'done',
      )
      if (failed.length > 0) {
        const pages = failed.length === 1 ? 'page' : 'pages'
        throw new Error(`The text of ${pages} ${joinList(failed.map(String))} could not be extracted.`)
      }
    },
    [queue, model, prompt],
  )
  useEffect(() => runner.setPrepare(prepareDocument), [runner, prepareDocument])

  const openSettings = (focusModels = false) => {
    setFocusModelInput(focusModels)
    setSettingsOpen(true)
  }

  const addModel = (name: string) => {
    setAddedModels((current) => (current.includes(name) ? current : [...current, name]))
    setSavedModel(name)
    notify(`Added ${name}. It is now selected.`, 'info')
  }

  const removeModel = (name: string) => setAddedModels((current) => current.filter((added) => added !== name))

  // ---------- What is shown ----------

  const view = currentView(chosenView, exams, documents, catalog, lastEvaluator)
  const currentExamId = view.kind === 'evaluator' || view.kind === 'document' ? view.examId : null
  const summary = exams.find((exam) => exam.id === currentExamId)
  const sitting = currentSitting(catalog, chosenSitting)

  const navigate = (next: View): boolean => {
    const leavingEvaluator = view.kind === 'evaluator' && (next.kind !== 'evaluator' || next.examId !== view.examId)
    if (leavingEvaluator && editorDirty.current && !window.confirm('Discard the unsaved changes to this evaluator?')) {
      return false
    }
    if (leavingEvaluator) editorDirty.current = false
    setChosenView(next)
    if (next.kind === 'evaluator' || next.kind === 'document') {
      setLastEvaluator(next.examId)
      // Show the sidebar for the sitting the paper is in.
      const sittingId = exams.find((exam) => exam.id === next.examId)?.sitting_id
      if (sittingId) setChosenSitting(sittingId)
    } else {
      setLastEvaluator('')
    }
    return true
  }

  const openExam = (exam: ExamSummary) =>
    navigate({ kind: 'evaluator', examId: exam.id, tab: exam.question_count > 0 ? 'papers' : 'key' })

  /** A subject's paper in an exam sitting, or the subject's page when it has none there yet. */
  const openSubject = (subjectId: string, sittingId = sitting?.id) => {
    const exam = paperOf(exams, subjectId, sittingId)
    if (exam) openExam(exam)
    else navigate({ kind: 'subject', subjectId })
  }

  const toggleExpanded = (id: string) =>
    setExpanded((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))

  const setEditorDirty = useCallback((dirty: boolean) => {
    editorDirty.current = dirty
  }, [])

  // ---------- Evaluators ----------

  const loadingExams = useRef(new Set<string>())
  const loadExam = useCallback(
    (examId: string) => {
      if (loadingExams.current.has(examId)) return
      loadingExams.current.add(examId)
      api
        .getExam(examId)
        .then((exam) => setExamDetails((current) => ({ ...current, [exam.id]: exam })))
        .catch((error) => notify(`Could not load the evaluator: ${errorMessage(error)}`))
        .finally(() => loadingExams.current.delete(examId))
    },
    [notify],
  )
  useEffect(() => {
    if (currentExamId && !examDetails[currentExamId]) loadExam(currentExamId)
  }, [currentExamId, examDetails, loadExam])

  const examSaved = useCallback((exam: Exam) => {
    setExamDetails((current) => ({ ...current, [exam.id]: exam }))
    setExams((current) => current.map((candidate) => (candidate.id === exam.id ? summaryOf(exam) : candidate)))
  }, [])

  const setKeyDocument = (examId: string, documentId: string | null) => {
    setExams((current) => current.map((exam) => (exam.id === examId ? { ...exam, key_document_id: documentId } : exam)))
    setExamDetails((current) =>
      current[examId] ? { ...current, [examId]: { ...current[examId], key_document_id: documentId } } : current,
    )
  }

  const createEvaluator = async (placement?: Placement, name = 'Untitled evaluator') => {
    if (view.kind === 'evaluator' && editorDirty.current && !window.confirm('Discard the unsaved changes?')) return
    try {
      const exam = await api.createExam({ name, questions: [], ...placement })
      setExams((current) => [summaryOf(exam), ...current])
      setExamDetails((current) => ({ ...current, [exam.id]: exam }))
      editorDirty.current = false
      setChosenView({ kind: 'evaluator', examId: exam.id, tab: 'key' })
      setLastEvaluator(exam.id)
    } catch (error) {
      notify(`Could not create an evaluator: ${errorMessage(error)}`)
    }
  }

  const deleteEvaluator = async (exam: ExamSummary) => {
    const papers = papersOf(documents, exam.id)
    const parts = [
      exam.key_document_id ? 'its key file' : null,
      papers.length > 0 ? `its ${pluralize(papers.length, 'answer paper')}` : null,
      evaluations.some((evaluation) => evaluation.exam_id === exam.id) ? 'their marks' : null,
    ].filter((part) => part !== null)
    const also = parts.length > 0 ? `, with ${joinList(parts)}` : ''
    if (!window.confirm(`Delete the evaluator "${exam.name}"${also}?`)) return
    keyControllers.current.get(exam.id)?.abort()
    for (const document of documents.filter((candidate) => candidate.exam_id === exam.id)) {
      runner.remove(document.id)
      queue.remove((job) => job.documentId === document.id)
    }
    try {
      await api.deleteExam(exam.id)
    } catch (error) {
      notify(`Could not delete ${exam.name}: ${errorMessage(error)}`)
      return
    }
    editorDirty.current = false
    setExams((current) => current.filter((candidate) => candidate.id !== exam.id))
    updateDocuments((current) => current.filter((document) => document.exam_id !== exam.id))
    setEvaluations((current) => current.filter((evaluation) => evaluation.exam_id !== exam.id))
    setChosenView(exam.subject_id ? { kind: 'subject', subjectId: exam.subject_id } : null)
    setLastEvaluator('')
  }

  /** Set up a subject's paper for the exam sitting being shown. */
  const createPaper = async (subjectId: string) => {
    const subject = catalog.subjects.find((candidate) => candidate.id === subjectId)
    if (!subject || !sitting) return
    await createEvaluator(
      { subject_id: subject.id, sitting_id: sitting.id },
      `${subjectLabel(subject)} · ${sitting.name}`,
    )
  }

  /** Make an evaluator a subject's paper in a sitting, or take it out of the structure. Throws if it can't. */
  const placeExam = async (examId: string, placement: Placement) => {
    const exam = await api.placeExam(examId, placement)
    examSaved(exam)
    if (exam.sitting_id) setChosenSitting(exam.sitting_id)
  }

  const loadSample = async () => {
    try {
      const loaded = await api.loadSampleCatalog()
      setCatalog(loaded)
      setChosenSitting(loaded.sittings.at(-1)?.id ?? '')
      navigate({ kind: 'overview', scope: { kind: 'institution' } })
      notify(
        `Added ${loaded.institution.name}. Pick a subject on the left to set up its paper, or change anything under College structure.`,
        'info',
      )
    } catch (error) {
      notify(`Could not add the sample college: ${errorMessage(error)}`)
    }
  }

  // ---------- Reading the key file ----------

  const keyControllers = useRef(new Map<string, AbortController>())
  const updateKeyRead = (examId: string, changes: Partial<KeyRead>) =>
    setKeyReads((current) => (current[examId] ? { ...current, [examId]: { ...current[examId], ...changes } } : current))
  const forgetKeyRead = (examId: string) =>
    setKeyReads((current) => {
      const { [examId]: _, ...rest } = current
      void _
      return rest
    })

  /** Extract the text of the key file's pages one by one, then have the model read the questions from it. */
  const readKey = async (examId: string, documentId: string, extractAll = false) => {
    const document = documentsRef.current.find((candidate) => candidate.id === documentId)
    if (!document) return
    if (!gradingModel) {
      notify('Choose a marking model first.')
      return
    }
    keyControllers.current.get(examId)?.abort()
    const abort = new AbortController()
    keyControllers.current.set(examId, abort)
    // A read that was stopped, or replaced by a newer one, leaves the progress alone.
    const current = () => keyControllers.current.get(examId) === abort
    const update = (changes: Partial<KeyRead>) => current() && updateKeyRead(examId, changes)
    const extracting = document.pages.filter((page) => extractAll || !page.ocr).map((page) => page.number)
    setKeyReads((current) => ({
      ...current,
      [examId]: {
        documentId,
        extracting,
        extract: extracting.length > 0 ? 'running' : 'done',
        read: 'waiting',
        received: 0,
        attempt: 1,
      },
    }))
    try {
      if (extracting.length > 0) {
        try {
          await prepareDocument(documentId, abort.signal, { all: extractAll })
        } catch (error) {
          if (abort.signal.aborted) throw error
          update({ extract: 'failed', extractError: errorMessage(error) })
          return
        }
        update({ extract: 'done' })
      }
      update({ read: 'running', readStartedAt: Date.now() })
      for await (const event of api.readKey(examId, { model: gradingModel }, abort.signal)) {
        if (event.type === 'start') update({ sent: event.characters })
        else if (event.type === 'progress') update({ received: event.characters, attempt: event.attempt })
        else if (event.type === 'error') {
          update({ read: 'failed', readError: event.message, reply: event.reply })
          return
        } else if (event.type === 'done') {
          // Saved on the server either way.
          examSaved(event.exam)
          if (!current()) return
          forgetKeyRead(examId)
          notify(
            `Read ${pluralize(event.exam.questions.length, 'question')} from ${document.filename}. Check them, and set any missing marks.`,
            'info',
          )
          return
        }
      }
      update({ read: 'failed', readError: 'The connection closed before the model finished.' })
    } catch (error) {
      if (!current()) return
      if (abort.signal.aborted) forgetKeyRead(examId)
      else update({ read: 'failed', readError: errorMessage(error) })
    } finally {
      if (keyControllers.current.get(examId) === abort) keyControllers.current.delete(examId)
    }
  }

  // ---------- Uploads ----------

  // Uploads run one after another, even when more files are dropped during an upload.
  const uploads = useRef(Promise.resolve())
  const uploadFiles = (
    files: File[],
    to: { examId: string; role: DocumentRole },
    onUploaded: (document: DocumentInfo) => void,
  ) => {
    const limitMb = config?.max_upload_mb ?? 50
    uploads.current = uploads.current.then(async () => {
      for (const [index, file] of files.entries()) {
        if (file.size > limitMb * MB) {
          notify(`${file.name} is larger than the ${limitMb} MB limit.`)
          continue
        }
        setUpload({ ...to, name: file.name, index: index + 1, total: files.length })
        try {
          const document = await api.uploadDocument(file, to)
          // A new key file replaces the old one, which stays uploaded but leaves the evaluator.
          updateDocuments((current) => [
            document,
            ...current.map((candidate) =>
              to.role === 'key' && candidate.exam_id === to.examId && candidate.role === 'key'
                ? { ...candidate, exam_id: null, role: null }
                : candidate,
            ),
          ])
          onUploaded(document)
        } catch (error) {
          notify(`Could not upload ${file.name}: ${errorMessage(error)}`)
        }
      }
      setUpload(null)
    })
  }

  /** Whether it is fine to read the questions from a new key file, replacing the evaluator's questions. */
  const mayReplaceQuestions = (examId: string, filename: string) => {
    const count = exams.find((exam) => exam.id === examId)?.question_count ?? 0
    return (
      count === 0 ||
      window.confirm(
        `Read the questions from ${filename}? This replaces the ${pluralize(count, 'question')} this evaluator has now.`,
      )
    )
  }

  const uploadKey = (examId: string, files: File[]) => {
    if (files.length > 1) notify('An evaluator has one key file: using the first one.', 'info')
    if (!mayReplaceQuestions(examId, files[0].name)) return
    uploadFiles(files.slice(0, 1), { examId, role: 'key' }, (document) => {
      setKeyDocument(examId, document.id)
      void readKey(examId, document.id)
    })
  }

  const startEvaluation = (examId: string, documentId: string, marking: string) =>
    runner.start({ kind: 'evaluate', documentId, examId, model: marking })

  const uploadPapers = (examId: string, files: File[]) => {
    const problem = keyProblem(exams.find((exam) => exam.id === examId))
    const marking = gradingModel
    if (!problem && !marking) notify('Choose a marking model to have the papers marked.')
    uploadFiles(files, { examId, role: 'script' }, (document) => {
      if (!problem && marking) startEvaluation(examId, document.id, marking)
    })
  }

  /** Use a document uploaded earlier as the key file or as an answer paper. */
  const assignEarlierFile = async (examId: string, documentId: string, role: DocumentRole) => {
    const filename = documents.find((candidate) => candidate.id === documentId)?.filename ?? 'that file'
    if (role === 'key' && !mayReplaceQuestions(examId, filename)) return
    let document: DocumentInfo
    try {
      document = await api.assignDocument(documentId, { exam_id: examId, role })
    } catch (error) {
      notify(`Could not use that file: ${errorMessage(error)}`)
      return
    }
    updateDocuments((current) =>
      current.map((candidate) =>
        candidate.id === documentId
          ? document
          : role === 'key' && candidate.exam_id === examId && candidate.role === 'key'
            ? { ...candidate, exam_id: null, role: null }
            : candidate,
      ),
    )
    if (role === 'key') {
      setKeyDocument(examId, documentId)
      void readKey(examId, documentId)
    } else if (!keyProblem(exams.find((exam) => exam.id === examId)) && gradingModel) {
      startEvaluation(examId, documentId, gradingModel)
    }
  }

  const importJson = async (examId: string, file: File) => {
    const exam = examDetails[examId]
    if (!exam) return
    if (editorDirty.current && !window.confirm('Importing replaces the questions, and your unsaved changes. Go on?'))
      return
    try {
      const draft = parseAnswerKey(await file.text(), fileStem(file.name))
      const name = exam.name === 'Untitled evaluator' ? draft.name : exam.name
      const saved = await api.updateExam(examId, { name, questions: draft.questions })
      editorDirty.current = false
      examSaved(saved)
      notify(`Imported ${pluralize(saved.questions.length, 'question')}.`, 'info')
    } catch (error) {
      notify(`Could not import ${file.name}: ${errorMessage(error)}`)
    }
  }

  const dragging = useFileDrop((files) => {
    if (view.kind !== 'evaluator' && view.kind !== 'document') {
      notify("Open a subject's paper or an evaluator first, then drop the files into it.", 'info')
    } else if (view.kind === 'evaluator' && view.tab === 'key') {
      uploadKey(view.examId, files)
    } else {
      uploadPapers(view.examId, files)
      // Show the papers being marked.
      if (view.kind !== 'evaluator' || view.tab !== 'papers')
        navigate({ kind: 'evaluator', examId: view.examId, tab: 'papers' })
    }
  })

  // ---------- Answer papers ----------

  const loadingEvaluations = useRef(new Set<string>())
  const loadEvaluation = useCallback(
    (evaluationId: string) => {
      if (loadingEvaluations.current.has(evaluationId)) return
      loadingEvaluations.current.add(evaluationId)
      api
        .getEvaluation(evaluationId)
        .then((evaluation) => setDetails((current) => ({ ...current, [evaluation.id]: evaluation })))
        .catch((error) => notify(`Could not load the marks: ${errorMessage(error)}`))
        .finally(() => loadingEvaluations.current.delete(evaluationId))
    },
    [notify],
  )

  const grade = useCallback(
    (evaluation: Evaluation, questionIds?: string[]) => {
      if (!gradingModel) {
        notify('Choose a marking model first.')
        return
      }
      if (
        !runner.start({
          kind: 'grade',
          documentId: evaluation.document_id,
          evaluation,
          model: gradingModel,
          questionIds,
        })
      ) {
        notify('This paper is still being evaluated.')
      }
    },
    [runner, gradingModel, notify],
  )

  /** Evaluate a paper, finish marking one that was stopped part way, or evaluate a marked one again. */
  const evaluatePaper = async (examId: string, documentId: string, ask = true) => {
    const problem = keyProblem(exams.find((exam) => exam.id === examId))
    if (problem) {
      notify(problem)
      return
    }
    if (!gradingModel) {
      notify('Choose a marking model first.')
      return
    }
    const existing = evaluations.find(
      (evaluation) => evaluation.document_id === documentId && evaluation.exam_id === examId,
    )
    if (existing && !existing.complete) {
      try {
        grade(details[existing.id] ?? (await api.getEvaluation(existing.id)))
      } catch (error) {
        notify(errorMessage(error))
      }
      return
    }
    if (
      existing &&
      ask &&
      !window.confirm('Evaluate this paper again? Its marks are replaced, including any marks you changed.')
    ) {
      return
    }
    startEvaluation(examId, documentId, gradingModel)
  }

  const evaluateAll = (examId: string) => {
    for (const document of papersOf(documents, examId)) {
      const evaluation = evaluations.find(
        (candidate) => candidate.document_id === document.id && candidate.exam_id === examId,
      )
      const state = paperState(document, runs.get(document.id), evaluation, jobs)
      if (['idle', 'failed', 'partial'].includes(state.kind)) void evaluatePaper(examId, document.id, false)
    }
  }

  const stopAll = (examId: string) => {
    for (const document of documents.filter((candidate) => candidate.exam_id === examId)) runner.stop(document.id)
  }

  const deletePaper = async (document: DocumentInfo) => {
    const marked = evaluations.some((evaluation) => evaluation.document_id === document.id)
    if (!window.confirm(`Delete ${document.filename}${marked ? ' and its marks' : ''}?`)) return
    queue.remove((job) => job.documentId === document.id)
    runner.remove(document.id)
    try {
      await api.deleteDocument(document.id)
    } catch (error) {
      notify(`Could not delete ${document.filename}: ${errorMessage(error)}`)
      return
    }
    updateDocuments((current) => current.filter((candidate) => candidate.id !== document.id))
    setEvaluations((current) => current.filter((evaluation) => evaluation.document_id !== document.id))
  }

  const changeAnswer = useCallback(
    async (evaluation: Evaluation, questionId: string, changes: { answer?: string; teacher_marks?: number | null }) => {
      try {
        storeEvaluation(await api.changeAnswer(evaluation.id, questionId, changes))
        return true
      } catch (error) {
        notify(`Could not save: ${errorMessage(error)}`)
        return false
      }
    },
    [storeEvaluation, notify],
  )

  const changeStudent = useCallback(
    (evaluation: Evaluation, changes: { student_name?: string; roll_number?: string }) => {
      api
        .changeEvaluation(evaluation.id, changes)
        .then(storeEvaluation)
        .catch((error) => notify(`Could not save: ${errorMessage(error)}`))
    },
    [storeEvaluation, notify],
  )

  const deleteEvaluation = async (evaluation: Evaluation) => {
    if (!window.confirm(`Delete the marks of ${evaluation.document_name}?`)) return
    try {
      await api.deleteEvaluation(evaluation.id)
    } catch (error) {
      notify(`Could not delete the marks: ${errorMessage(error)}`)
      return
    }
    runner.dismiss(evaluation.document_id)
    setEvaluations((current) => current.filter((candidate) => candidate.id !== evaluation.id))
  }

  // ---------- Page ----------

  useEffect(() => {
    const document = view.kind === 'document' ? documents.find((candidate) => candidate.id === view.documentId) : null
    const subject =
      view.kind === 'subject' ? catalog.subjects.find((candidate) => candidate.id === view.subjectId) : undefined
    const title =
      document?.filename ??
      summary?.name ??
      (subject
        ? subjectLabel(subject)
        : view.kind === 'structure'
          ? 'College structure'
          : view.kind === 'overview'
            ? scopeTitle(catalog, view.scope)
            : undefined)
    window.document.title = title ? `${title} · PaperEval` : 'PaperEval'
  }, [view, documents, summary, catalog])

  const accepted = config?.accepted_extensions ?? ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff']
  const hasModels = offeredNames(groups).length > 0
  const looseDocuments = documents.filter((document) => !document.exam_id)
  const working = new Set(
    exams
      .filter(
        (exam) =>
          isKeyReading(keyReads[exam.id]) ||
          documents.some((document) => document.exam_id === exam.id && isRunning(runs.get(document.id))),
      )
      .map((exam) => exam.id),
  )
  const selectScope = (scope: Scope) => navigate({ kind: 'overview', scope })
  const openStructure = () => navigate({ kind: 'structure' })

  const main = () => {
    if (view.kind === 'structure') {
      return (
        <StructurePage
          catalog={catalog}
          exams={exams}
          onChange={setCatalog}
          onLoadSample={() => void loadSample()}
          onError={notify}
        />
      )
    }
    if (view.kind === 'overview') {
      return (
        <Overview
          catalog={catalog}
          scope={view.scope}
          sitting={sitting}
          exams={exams}
          documents={documents}
          evaluations={evaluations}
          working={working}
          onSelectScope={selectScope}
          onSelectSubject={openSubject}
          onOpenStructure={openStructure}
        />
      )
    }
    if (view.kind === 'subject') {
      const subject = catalog.subjects.find((candidate) => candidate.id === view.subjectId)
      if (!subject) return null
      return (
        <SubjectPage
          key={subject.id}
          catalog={catalog}
          subject={subject}
          sitting={sitting}
          exams={exams}
          onSelectScope={selectScope}
          onCreatePaper={() => createPaper(subject.id)}
          onUseEvaluator={async (examId) => {
            if (!sitting) return
            try {
              await placeExam(examId, { subject_id: subject.id, sitting_id: sitting.id })
              const exam = exams.find((candidate) => candidate.id === examId)
              if (exam) openExam(exam)
            } catch (error) {
              notify(errorMessage(error))
            }
          }}
          onOpenPaper={openExam}
          onOpenStructure={openStructure}
        />
      )
    }
    if (view.kind === 'home' || !summary) {
      return (
        <Welcome
          loading={loading}
          onLoadSample={() => void loadSample()}
          onOpenStructure={openStructure}
          onCreate={() => void createEvaluator()}
        />
      )
    }
    const examId = summary.id
    const exam = examDetails[examId]
    const keyDocument = documents.find((document) => document.id === summary.key_document_id)
    const papers = papersOf(documents, examId)
    const examEvaluations = evaluations.filter((evaluation) => evaluation.exam_id === examId)

    if (view.kind === 'document') {
      const document = documents.find((candidate) => candidate.id === view.documentId)
      const page = document?.pages.find((candidate) => candidate.number === view.pageNumber) ?? document?.pages[0]
      if (!document || !page) return null
      const isPaper = document.role === 'script'
      const key = pageKey(document.id, page.number)
      const back: View = { kind: 'evaluator', examId, tab: isPaper ? 'papers' : 'key' }
      return (
        <Workspace
          document={document}
          page={page}
          job={jobs.get(key)}
          model={model}
          panel={panel}
          onPanelChange={setPanel}
          backLabel={isPaper ? 'Answer papers' : 'Questions & key'}
          onBack={() => navigate(back)}
          marks={
            isPaper ? (
              <EvaluationPanel
                key={document.id}
                document={document}
                summaries={examEvaluations.filter((evaluation) => evaluation.document_id === document.id)}
                details={details}
                run={runs.get(document.id)}
                jobs={jobs}
                exams={exams}
                examDetails={examDetails}
                preview={answerPreview}
                onPreviewChange={setAnswerPreview}
                gradingModel={gradingModel}
                onLoadEvaluation={loadEvaluation}
                onLoadExam={loadExam}
                onEvaluate={() => void evaluatePaper(examId, document.id)}
                onStop={() => runner.stop(document.id)}
                onDismissRun={() => runner.dismiss(document.id)}
                onGrade={grade}
                onChangeAnswer={changeAnswer}
                onChangeStudent={changeStudent}
                onDelete={(evaluation) => void deleteEvaluation(evaluation)}
                onSelectPage={(pageNumber) => navigate({ ...view, pageNumber })}
                onOpenKey={() => navigate({ kind: 'evaluator', examId, tab: 'key' })}
              />
            ) : null
          }
          onSelectPage={(pageNumber) => navigate({ ...view, pageNumber })}
          onExtract={() => {
            if (!model) notify('Choose a reading model at the top first.')
            else queue.enqueue({ documentId: document.id, pageNumber: page.number, model, prompt })
          }}
          onStop={() => queue.cancel(key)}
          onDismiss={() => queue.dismiss(key)}
          onError={notify}
        />
      )
    }

    const tab = view.tab
    const uploadingHere = upload?.examId === examId
    const problem = keyProblem(summary)
    const marked = examEvaluations.filter((evaluation) => evaluation.complete).length
    return (
      <EvaluatorView
        key={examId}
        summary={summary}
        exam={exam}
        tab={tab}
        onTabChange={(next) => navigate({ kind: 'evaluator', examId, tab: next })}
        paperCount={papers.length}
        markedCount={marked}
        gradingModel={gradingModel}
        onGradingModelChange={setSavedGradingModel}
        models={allModels}
        addedModels={extraModels}
        onSaved={examSaved}
        onDelete={() => void deleteEvaluator(summary)}
        onDirtyChange={setEditorDirty}
        onError={notify}
        context={evaluatorContext(summary)}
      >
        {(draft, change, dirty) =>
          tab === 'key' ? (
            <KeyStep
              keyDocument={keyDocument}
              looseDocuments={looseDocuments}
              keyRead={keyReads[examId]}
              jobs={jobs}
              ocrModel={model}
              gradingModel={gradingModel}
              accept={accepted}
              uploading={uploadingHere && upload?.role === 'key'}
              questions={draft.questions}
              onQuestionsChange={(questions) => change({ questions })}
              onUploadKey={(files) => uploadKey(examId, files)}
              onUseDocument={(documentId) => void assignEarlierFile(examId, documentId, 'key')}
              onReadKey={(extractAll) => keyDocument && void readKey(examId, keyDocument.id, extractAll)}
              onCancelKeyRead={() => keyControllers.current.get(examId)?.abort()}
              onDismissKeyRead={() => forgetKeyRead(examId)}
              onViewKeyPages={() =>
                keyDocument && navigate({ kind: 'document', examId, documentId: keyDocument.id, pageNumber: 1 })
              }
              onImportJson={(file) => void importJson(examId, file)}
            />
          ) : tab === 'papers' ? (
            <PapersStep
              papers={papers}
              looseDocuments={looseDocuments}
              evaluations={examEvaluations}
              runs={runs}
              jobs={jobs}
              keyProblem={
                isKeyReading(keyReads[examId]) ? 'The questions are still being read from the key file.' : problem
              }
              accept={accepted}
              uploading={uploadingHere && upload?.role === 'script'}
              onUploadPapers={(files) => uploadPapers(examId, files)}
              onUseDocument={(documentId) => void assignEarlierFile(examId, documentId, 'script')}
              onEvaluate={(documentId) => void evaluatePaper(examId, documentId)}
              onEvaluateAll={() => evaluateAll(examId)}
              onStop={(documentId) => runner.stop(documentId)}
              onStopAll={() => stopAll(examId)}
              onOpenPaper={(documentId) => {
                setPanel('marks')
                navigate({ kind: 'document', examId, documentId, pageNumber: 1 })
              }}
              onDeletePaper={(document) => void deletePaper(document)}
              onGoToKey={() => navigate({ kind: 'evaluator', examId, tab: 'key' })}
            />
          ) : exam ? (
            <ResultsStep
              exam={exam}
              evaluations={examEvaluations}
              active={papers.filter((document) => isRunning(runs.get(document.id))).map((document) => document.id)}
              documents={papers}
              onOpenPaper={(documentId) => {
                setPanel('marks')
                navigate({ kind: 'document', examId, documentId, pageNumber: 1 })
              }}
              onStopRuns={(documentIds) => documentIds.forEach((documentId) => runner.stop(documentId))}
              onError={notify}
              unsaved={dirty}
            />
          ) : null
        }
      </EvaluatorView>
    )
  }

  /** Where an evaluator sits in the college, with a way to file it under a subject or move it. */
  function evaluatorContext(exam: ExamSummary) {
    const examSitting = catalog.sittings.find((candidate) => candidate.id === exam.sitting_id)
    if (!exam.subject_id || !examSitting) {
      if (catalog.subjects.length === 0 || catalog.sittings.length === 0) return undefined
      return (
        <div className="exam-placement">
          <span className="muted">Not filed under a subject</span>
          <button type="button" className="link-btn" onClick={() => setPlacingExamId(exam.id)}>
            <FolderInput size={14} aria-hidden />
            File under a subject
          </button>
        </div>
      )
    }
    const path = pathTo(catalog, { kind: 'subject', subjectId: exam.subject_id })
    return (
      <div className="exam-placement">
        <Breadcrumb
          items={path.map((step) => {
            const scope = step.scope
            return { label: step.label, onClick: scope ? () => selectScope(scope) : undefined }
          })}
        />
        <span className="chip chip-sitting" title={SITTING_KINDS[examSitting.kind]}>
          <CalendarDays size={12} aria-hidden />
          {examSitting.name}
          {examSitting.academic_year && ` · ${examSitting.academic_year}`}
        </span>
        <button type="button" className="link-btn link-btn-quiet" onClick={() => setPlacingExamId(exam.id)}>
          Move
        </button>
      </div>
    )
  }

  const placing = exams.find((exam) => exam.id === placingExamId)
  const selection: NavSelection =
    view.kind === 'overview'
      ? { kind: 'scope', scope: view.scope }
      : view.kind === 'subject'
        ? { kind: 'subject', subjectId: view.subjectId }
        : view.kind === 'structure'
          ? { kind: 'structure' }
          : currentExamId
            ? { kind: 'exam', examId: currentExamId }
            : { kind: 'none' }

  return (
    <div className="app">
      <Header
        status={status}
        checking={checking}
        models={groups}
        model={model}
        onModelChange={setSavedModel}
        onAddModel={() => openSettings(true)}
        onRefresh={refreshStatus}
        onOpenSettings={() => openSettings()}
      />

      {status && !status.reachable && (
        <div className="banner banner-error" role="alert">
          <CloudOff size={18} aria-hidden />
          <span>
            <strong>Can't reach {status.cloud ? 'Ollama Cloud' : 'Ollama'}.</strong> {status.error}
          </span>
          <button type="button" className="btn btn-small" onClick={refreshStatus}>
            <RefreshCw size={13} aria-hidden />
            Retry
          </button>
        </div>
      )}
      {status?.reachable && status.cloud && !status.api_key_configured && (
        <div className="banner banner-warning" role="status">
          <TriangleAlert size={18} aria-hidden />
          <span>
            No API key is set. Set <code>OLLAMA_API_KEY</code> on the backend to use Ollama Cloud models.
          </span>
        </div>
      )}
      {status?.reachable && !hasModels && (
        <div className="banner banner-warning" role="status">
          <TriangleAlert size={18} aria-hidden />
          <span>
            {status.cloud ? (
              'No vision models are available from Ollama Cloud right now. You can still add a model by name from the model list.'
            ) : (
              <>
                No vision models found. Pull one (for example <code>ollama pull qwen2.5vl</code>), run{' '}
                <code>ollama signin</code> to use Ollama Cloud models, or add a model by name from the model list.
              </>
            )}
          </span>
        </div>
      )}

      <div className="main">
        <CollegeNav
          catalog={catalog}
          sitting={sitting}
          exams={exams}
          documents={documents}
          evaluations={evaluations}
          runs={runs}
          keyReads={keyReads}
          loading={loading}
          selection={selection}
          expanded={expanded}
          onToggle={toggleExpanded}
          onSittingChange={(sittingId) => {
            setChosenSitting(sittingId)
            // A paper belongs to one sitting: show the same subject in the new one.
            const subjectId = view.kind === 'subject' ? view.subjectId : summary?.subject_id
            if (subjectId) openSubject(subjectId, sittingId)
          }}
          onSelectScope={selectScope}
          onSelectSubject={(subjectId) => openSubject(subjectId)}
          onSelectExam={(examId) => {
            const exam = exams.find((candidate) => candidate.id === examId)
            if (exam) openExam(exam)
          }}
          onCreateEvaluator={() => void createEvaluator()}
          onOpenStructure={openStructure}
          onLoadSample={() => void loadSample()}
        />
        <main className="content">{main()}</main>
      </div>

      {placing && (
        <PlacementDialog
          open={placingExamId !== null}
          catalog={catalog}
          exam={placing}
          defaultSittingId={sitting?.id}
          onClose={() => setPlacingExamId(null)}
          onSave={(placement) => placeExam(placing.id, placement)}
        />
      )}

      <SettingsDialog
        open={settingsOpen}
        focusModelInput={focusModelInput}
        onClose={() => setSettingsOpen(false)}
        config={config}
        status={status}
        prompt={prompt}
        onPromptChange={setPrompt}
        addedModels={addedModels}
        onAddModel={addModel}
        onRemoveModel={removeModel}
      />

      {dragging && (
        <div className="drop-overlay" aria-hidden>
          <div className="drop-overlay-inner">
            <FileUp size={40} strokeWidth={1.5} />
            <p>
              {view.kind === 'evaluator' && view.tab === 'key'
                ? 'Drop the question paper with its answer key'
                : view.kind === 'evaluator' || view.kind === 'document'
                  ? 'Drop the answer papers to mark them'
                  : "Open a subject's paper first"}
            </p>
          </div>
        </div>
      )}
      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}
