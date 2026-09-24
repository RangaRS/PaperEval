import { CloudOff, FileUp, RefreshCw, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import {
  api,
  type AppConfig,
  type DocumentInfo,
  type Evaluation,
  type EvaluationSummary,
  type Exam,
  type ExamSummary,
  type OllamaStatus,
} from './api'
import { EmptyState } from './components/EmptyState'
import { EvaluateDialog, type EvaluateTarget } from './components/EvaluateDialog'
import { EvaluationPanel } from './components/EvaluationPanel'
import { ExamEditor } from './components/ExamEditor'
import { ExamList, ExamsEmptyState } from './components/ExamList'
import { Header } from './components/Header'
import { KeyFromDocumentDialog } from './components/KeyFromDocumentDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { PaperList, Sidebar, type Selection, type SidebarMode, type UploadProgress } from './components/Sidebar'
import { Toasts } from './components/Toasts'
import { Workspace, type WorkspacePanel } from './components/Workspace'
import { EvaluationRunner } from './evaluationRunner'
import { blankQuestion, joinList, parseAnswerKey, questionLabel, summarize, withSummary } from './exams'
import { isBoolean, isString, isStringArray, useFileDrop, useLocalStorage, useToasts } from './hooks'
import { chooseModel, modelGroups, offeredNames } from './models'
import { OcrQueue, pageKey } from './ocrQueue'
import { documentText, downloadText, errorMessage, fileStem, pluralize } from './utils'

const MB = 1024 * 1024
const isPrompt = (value: unknown): value is string | null => value === null || typeof value === 'string'
const isMode = (value: unknown): value is SidebarMode => value === 'papers' || value === 'keys'
const isPanel = (value: unknown): value is WorkspacePanel => value === 'text' || value === 'marks'

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

const examSummary = (exam: Exam): ExamSummary => ({
  id: exam.id,
  name: exam.name,
  created_at: exam.created_at,
  updated_at: exam.updated_at,
  question_count: exam.questions.length,
  total_marks: exam.total_marks,
  unmarked_questions: exam.questions.flatMap((question, index) =>
    question.max_marks <= 0 ? [questionLabel(question.number, index)] : [],
  ),
})

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [status, setStatus] = useState<OllamaStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const [documents, setDocuments] = useState<DocumentInfo[]>([])
  const [loadingDocuments, setLoadingDocuments] = useState(true)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [upload, setUpload] = useState<UploadProgress | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [focusModelInput, setFocusModelInput] = useState(false)
  const [savedModel, setSavedModel] = useLocalStorage('papereval.model', '', isString)
  const [addedModels, setAddedModels] = useLocalStorage<string[]>('papereval.addedModels', [], isStringArray)
  const [customPrompt, setCustomPrompt] = useLocalStorage<string | null>('papereval.prompt', null, isPrompt)
  const { toasts, notify, dismiss: dismissToast } = useToasts()

  const [mode, setMode] = useLocalStorage<SidebarMode>('papereval.mode', 'papers', isMode)
  const [panel, setPanel] = useLocalStorage<WorkspacePanel>('papereval.panel', 'text', isPanel)
  const [answerPreview, setAnswerPreview] = useLocalStorage('papereval.answerPreview', true, isBoolean)
  const [savedGradingModel, setSavedGradingModel] = useLocalStorage('papereval.gradingModel', '', isString)
  const [exams, setExams] = useState<ExamSummary[]>([])
  const [loadingExams, setLoadingExams] = useState(true)
  const [chosenExamId, setChosenExamId] = useState<string | null>(null)
  const [evaluations, setEvaluations] = useState<EvaluationSummary[]>([])
  const [details, setDetails] = useState<Record<string, Evaluation>>({})
  const [examDetails, setExamDetails] = useState<Record<string, Exam>>({})
  const [evaluateTarget, setEvaluateTarget] = useState<EvaluateTarget | null>(null)
  const [keyFromDocumentOpen, setKeyFromDocumentOpen] = useState(false)
  // Whether the answer key being edited has unsaved changes.
  const editorDirty = useRef(false)

  const [queue] = useState(
    () =>
      new OcrQueue({
        run: (job, signal) =>
          api.extractText(job.documentId, job.pageNumber, { model: job.model, prompt: job.prompt }, signal),
        onResult: (job, result) =>
          setDocuments((current) => withPageText(current, job.documentId, job.pageNumber, result)),
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
    api
      .listDocuments()
      .then((loaded) => {
        setDocuments(loaded)
        setSelection((current) => current ?? (loaded[0] ? { documentId: loaded[0].id, pageNumber: 1 } : null))
      })
      .catch((error) => notify(errorMessage(error)))
      .finally(() => setLoadingDocuments(false))
    api
      .listExams()
      .then(setExams)
      .catch((error) => notify(`Could not load the answer keys: ${errorMessage(error)}`))
      .finally(() => setLoadingExams(false))
    api
      .listEvaluations()
      .then(setEvaluations)
      .catch((error) => notify(`Could not load the marks: ${errorMessage(error)}`))
  }, [notify])

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
  const model = chooseModel(savedModel, configuredModel, groups, (status?.models.length ?? 0) > 0)
  const prompt = customPrompt ?? config?.default_prompt ?? ''
  const setPrompt = (value: string) => setCustomPrompt(value === config?.default_prompt ? null : value)
  // Marking needs no images, so any model will do; it defaults to the one that reads the pages.
  const gradingModel = savedGradingModel || model
  const allModels = status?.models ?? []
  const extraModels = useMemo(() => [...addedModels, configuredModel].filter(Boolean), [addedModels, configuredModel])

  const documentsRef = useRef(documents)
  useEffect(() => {
    documentsRef.current = documents
  }, [documents])

  /** Extract the text of a paper's pages that have none, as needed before it is evaluated. */
  const prepareDocument = useCallback(
    async (documentId: string, signal: AbortSignal) => {
      const document = documentsRef.current.find((candidate) => candidate.id === documentId)
      if (!document) throw new Error('The paper was deleted.')
      const missing = document.pages.filter((page) => !page.ocr).map((page) => page.number)
      if (missing.length === 0) return
      if (!model) throw new Error('Some pages have no text yet. Choose a vision model at the top to read them.')
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
        throw new Error(
          `The text of ${pages} ${joinList(failed.map(String))} could not be extracted. See the ${pages} for why.`,
        )
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

  /** Whether it is fine to leave the answer key being edited. */
  const canLeaveEditor = useCallback(
    () => !editorDirty.current || window.confirm('Discard the unsaved changes to this answer key?'),
    [],
  )
  const setEditorDirty = useCallback((dirty: boolean) => {
    editorDirty.current = dirty
  }, [])

  const changeMode = (next: SidebarMode) => {
    if (next === mode || (mode === 'keys' && !canLeaveEditor())) return
    setMode(next)
  }

  const selectPage = useCallback(
    (documentId: string, pageNumber: number) => setSelection({ documentId, pageNumber }),
    [],
  )

  const extract = useCallback(
    (documentId: string, pageNumber: number) => {
      if (!model) {
        notify('Choose a vision model first.')
        return
      }
      queue.enqueue({ documentId, pageNumber, model, prompt })
    },
    [queue, model, prompt, notify],
  )

  const extractPage = useCallback(
    (documentId: string, pageNumber: number) => {
      setSelection({ documentId, pageNumber })
      extract(documentId, pageNumber)
    },
    [extract],
  )

  const stopPage = useCallback(
    (documentId: string, pageNumber: number) => queue.cancel(pageKey(documentId, pageNumber)),
    [queue],
  )

  const extractAll = useCallback(
    (document: DocumentInfo) => {
      if (!model) {
        notify('Choose a vision model first.')
        return
      }
      for (const page of document.pages) {
        if (!page.ocr) queue.enqueue({ documentId: document.id, pageNumber: page.number, model, prompt })
      }
    },
    [queue, model, prompt, notify],
  )

  const stopAll = useCallback(
    (document: DocumentInfo) => queue.cancelAll((job) => job.documentId === document.id),
    [queue],
  )

  const downloadDocument = useCallback(
    (document: DocumentInfo) => downloadText(`${fileStem(document.filename)}.txt`, documentText(document)),
    [],
  )

  const deleteDocument = useCallback(
    async (document: DocumentInfo) => {
      const marked = evaluations.some((evaluation) => evaluation.document_id === document.id)
      const what = marked ? 'its extracted text and marks' : 'its extracted text'
      if (!window.confirm(`Delete "${document.filename}" and ${what}?`)) return
      queue.remove((job) => job.documentId === document.id)
      runner.remove(document.id)
      try {
        await api.deleteDocument(document.id)
      } catch (error) {
        notify(`Could not delete ${document.filename}: ${errorMessage(error)}`)
        return
      }
      const remaining = documents.filter((candidate) => candidate.id !== document.id)
      setDocuments((current) => current.filter((candidate) => candidate.id !== document.id))
      setEvaluations((current) => current.filter((evaluation) => evaluation.document_id !== document.id))
      setSelection((current) =>
        current?.documentId !== document.id
          ? current
          : remaining[0]
            ? { documentId: remaining[0].id, pageNumber: 1 }
            : null,
      )
    },
    [queue, runner, notify, documents, evaluations],
  )

  const openMarks = useCallback(
    (document: DocumentInfo) => {
      setSelection((current) =>
        current?.documentId === document.id ? current : { documentId: document.id, pageNumber: 1 },
      )
      setPanel('marks')
    },
    [setPanel],
  )

  // Uploads run one after another, even when more files are dropped during an upload.
  const uploads = useRef(Promise.resolve())
  const uploadFiles = useCallback(
    (files: File[]) => {
      const limitMb = config?.max_upload_mb ?? 50
      uploads.current = uploads.current.then(async () => {
        for (const [index, file] of files.entries()) {
          if (file.size > limitMb * MB) {
            notify(`${file.name} is larger than the ${limitMb} MB limit.`)
            continue
          }
          setUpload({ name: file.name, index: index + 1, total: files.length })
          try {
            const document = await api.uploadDocument(file)
            setDocuments((current) => [document, ...current])
            setSelection({ documentId: document.id, pageNumber: 1 })
          } catch (error) {
            notify(`Could not upload ${file.name}: ${errorMessage(error)}`)
          }
        }
        setUpload(null)
      })
    },
    [config, notify],
  )
  const dragging = useFileDrop(uploadFiles)

  // ---------- Answer keys ----------

  const selectedExam = exams.find((exam) => exam.id === chosenExamId) ?? exams[0]

  const selectExam = (examId: string) => {
    if (examId === selectedExam?.id || !canLeaveEditor()) return
    setChosenExamId(examId)
  }

  const addExam = (exam: Exam) => {
    setExams((current) => [examSummary(exam), ...current.filter((candidate) => candidate.id !== exam.id)])
    setExamDetails((current) => ({ ...current, [exam.id]: exam }))
    setChosenExamId(exam.id)
    setMode('keys')
  }

  const createExam = async () => {
    if (mode === 'keys' && !canLeaveEditor()) return
    try {
      addExam(await api.createExam({ name: 'Untitled answer key', questions: [blankQuestion([])] }))
    } catch (error) {
      notify(`Could not create an answer key: ${errorMessage(error)}`)
    }
  }

  const importExam = async (file: File) => {
    if (mode === 'keys' && !canLeaveEditor()) return
    try {
      const draft = parseAnswerKey(await file.text(), fileStem(file.name))
      const exam = await api.createExam(draft)
      addExam(exam)
      notify(`Imported ${exam.name} with ${pluralize(exam.questions.length, 'question')}.`, 'info')
    } catch (error) {
      notify(`Could not import ${file.name}: ${errorMessage(error)}`)
    }
  }

  const examSaved = useCallback((exam: Exam) => {
    setExams((current) => current.map((candidate) => (candidate.id === exam.id ? examSummary(exam) : candidate)))
    setExamDetails((current) => ({ ...current, [exam.id]: exam }))
  }, [])

  const deleteExam = async (exam: Exam) => {
    const marked = evaluations.filter((evaluation) => evaluation.exam_id === exam.id).length
    const warning =
      marked > 0 ? ` The marks of the ${pluralize(marked, 'paper')} evaluated with it are deleted too.` : ''
    if (!window.confirm(`Delete the answer key "${exam.name}"?${warning}`)) return
    try {
      await api.deleteExam(exam.id)
    } catch (error) {
      notify(`Could not delete ${exam.name}: ${errorMessage(error)}`)
      return
    }
    editorDirty.current = false
    setExams((current) => current.filter((candidate) => candidate.id !== exam.id))
    setEvaluations((current) => current.filter((evaluation) => evaluation.exam_id !== exam.id))
    setChosenExamId(null)
  }

  const openPaper = useCallback(
    (documentId: string) => {
      if (!canLeaveEditor()) return
      setMode('papers')
      setSelection((current) => (current?.documentId === documentId ? current : { documentId, pageNumber: 1 }))
      setPanel('marks')
    },
    [canLeaveEditor, setMode, setPanel],
  )

  const openKey = useCallback(
    (examId: string) => {
      setChosenExamId(examId)
      setMode('keys')
    },
    [setMode],
  )

  // ---------- Evaluations ----------

  const loading = useRef(new Set<string>())
  const loadEvaluation = useCallback(
    (evaluationId: string) => {
      if (loading.current.has(evaluationId)) return
      loading.current.add(evaluationId)
      api
        .getEvaluation(evaluationId)
        .then((evaluation) => setDetails((current) => ({ ...current, [evaluation.id]: evaluation })))
        .catch((error) => notify(`Could not load the marks: ${errorMessage(error)}`))
        .finally(() => loading.current.delete(evaluationId))
    },
    [notify],
  )

  const loadExam = useCallback(
    (examId: string) => {
      if (loading.current.has(examId)) return
      loading.current.add(examId)
      api
        .getExam(examId)
        .then((exam) => setExamDetails((current) => ({ ...current, [exam.id]: exam })))
        .catch((error) => notify(`Could not load the answer key: ${errorMessage(error)}`))
        .finally(() => loading.current.delete(examId))
    },
    [notify],
  )

  const startEvaluations = (documentIds: string[], examId: string, chosenModel: string) => {
    setSavedGradingModel(chosenModel === model ? '' : chosenModel)
    for (const documentId of documentIds) {
      runner.start({ kind: 'evaluate', documentId, examId, model: chosenModel })
    }
  }

  const grade = useCallback(
    (evaluation: Evaluation, questionIds?: string[]) => {
      if (!gradingModel) {
        notify('Choose a model first.')
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

  const deleteEvaluation = useCallback(
    async (evaluation: Evaluation) => {
      if (!window.confirm(`Delete the marks of ${evaluation.document_name} from ${evaluation.exam_name}?`)) return
      try {
        await api.deleteEvaluation(evaluation.id)
      } catch (error) {
        notify(`Could not delete the marks: ${errorMessage(error)}`)
        return
      }
      runner.dismiss(evaluation.document_id)
      setEvaluations((current) => current.filter((candidate) => candidate.id !== evaluation.id))
    },
    [runner, notify],
  )

  const selectedDocument = documents.find((document) => document.id === selection?.documentId)
  const selectedPage = selectedDocument?.pages.find((page) => page.number === selection?.pageNumber)
  const selectedKey = selectedDocument && selectedPage ? pageKey(selectedDocument.id, selectedPage.number) : ''

  useEffect(() => {
    const title = mode === 'keys' ? selectedExam?.name : selectedDocument?.filename
    window.document.title = title ? `${title} · PaperEval` : 'PaperEval'
  }, [mode, selectedExam, selectedDocument])

  const accepted = config?.accepted_extensions ?? ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff']
  const hasModels = offeredNames(groups).length > 0

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
        <Sidebar mode={mode} onModeChange={changeMode} paperCount={documents.length} keyCount={exams.length}>
          {mode === 'papers' ? (
            <PaperList
              documents={documents}
              loading={loadingDocuments}
              jobs={jobs}
              evaluations={evaluations}
              runs={runs}
              selection={selection}
              upload={upload}
              acceptedExtensions={accepted}
              maxUploadMb={config?.max_upload_mb ?? 50}
              onUpload={uploadFiles}
              onSelect={selectPage}
              onExtract={extractPage}
              onStop={stopPage}
              onExtractAll={extractAll}
              onStopAll={stopAll}
              onDownload={downloadDocument}
              onDelete={deleteDocument}
              onOpenMarks={openMarks}
            />
          ) : (
            <ExamList
              exams={exams}
              loading={loadingExams}
              evaluations={evaluations}
              selectedId={selectedExam?.id ?? null}
              onSelect={selectExam}
              onCreate={() => void createExam()}
              onFromDocument={() => setKeyFromDocumentOpen(true)}
              onImport={(file) => void importExam(file)}
            />
          )}
        </Sidebar>
        <main className="content">
          {mode === 'keys' ? (
            selectedExam ? (
              <ExamEditor
                key={selectedExam.id}
                examId={selectedExam.id}
                evaluations={evaluations.filter((evaluation) => evaluation.exam_id === selectedExam.id)}
                runs={runs}
                documents={documents}
                onSaved={examSaved}
                onDelete={(exam) => void deleteExam(exam)}
                onOpenPaper={openPaper}
                onEvaluatePapers={() =>
                  setEvaluateTarget({
                    documentIds: documents
                      .filter(
                        (document) =>
                          !evaluations.some(
                            (evaluation) =>
                              evaluation.document_id === document.id && evaluation.exam_id === selectedExam.id,
                          ),
                      )
                      .map((document) => document.id),
                    examId: selectedExam.id,
                    choosePapers: true,
                  })
                }
                onStopRuns={(documentIds) => documentIds.forEach((documentId) => runner.stop(documentId))}
                onDirtyChange={setEditorDirty}
                onError={notify}
              />
            ) : (
              <ExamsEmptyState
                loading={loadingExams}
                onCreate={() => void createExam()}
                onFromDocument={() => setKeyFromDocumentOpen(true)}
              />
            )
          ) : selectedDocument && selectedPage ? (
            <Workspace
              document={selectedDocument}
              page={selectedPage}
              job={jobs.get(selectedKey)}
              model={model}
              panel={panel}
              onPanelChange={setPanel}
              marks={
                <EvaluationPanel
                  key={selectedDocument.id}
                  document={selectedDocument}
                  summaries={evaluations.filter((evaluation) => evaluation.document_id === selectedDocument.id)}
                  details={details}
                  run={runs.get(selectedDocument.id)}
                  exams={exams}
                  examDetails={examDetails}
                  preview={answerPreview}
                  onPreviewChange={setAnswerPreview}
                  gradingModel={gradingModel}
                  onLoadEvaluation={loadEvaluation}
                  onLoadExam={loadExam}
                  onEvaluate={(examId) =>
                    setEvaluateTarget({ documentIds: [selectedDocument.id], examId, choosePapers: false })
                  }
                  onStop={() => runner.stop(selectedDocument.id)}
                  onDismissRun={() => runner.dismiss(selectedDocument.id)}
                  onGrade={grade}
                  onChangeAnswer={changeAnswer}
                  onChangeStudent={changeStudent}
                  onDelete={(evaluation) => void deleteEvaluation(evaluation)}
                  onSelectPage={(pageNumber) => selectPage(selectedDocument.id, pageNumber)}
                  onOpenKey={openKey}
                />
              }
              onSelectPage={(pageNumber) => selectPage(selectedDocument.id, pageNumber)}
              onExtract={() => extract(selectedDocument.id, selectedPage.number)}
              onStop={() => queue.cancel(selectedKey)}
              onDismiss={() => queue.dismiss(selectedKey)}
              onError={notify}
            />
          ) : (
            <EmptyState
              hasDocuments={documents.length > 0}
              accept={accepted}
              busy={upload !== null}
              onUpload={uploadFiles}
            />
          )}
        </main>
      </div>

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

      <EvaluateDialog
        target={evaluateTarget}
        onClose={() => setEvaluateTarget(null)}
        documents={documents}
        exams={exams}
        evaluations={evaluations}
        model={gradingModel}
        onModelChange={setSavedGradingModel}
        models={allModels}
        addedModels={extraModels}
        ocrModel={model}
        onStart={startEvaluations}
        onCreateKey={() => {
          setEvaluateTarget(null)
          void createExam()
        }}
      />

      <KeyFromDocumentDialog
        open={keyFromDocumentOpen}
        onClose={() => setKeyFromDocumentOpen(false)}
        documents={documents}
        model={gradingModel}
        onModelChange={setSavedGradingModel}
        models={allModels}
        addedModels={extraModels}
        ocrModel={model}
        acceptedExtensions={accepted}
        uploading={upload !== null}
        onUpload={uploadFiles}
        prepare={prepareDocument}
        onCreated={(exam) => {
          addExam(exam)
          notify(`Read ${pluralize(exam.questions.length, 'question')}. Check them, and set any missing marks.`, 'info')
        }}
      />

      {dragging && (
        <div className="drop-overlay" aria-hidden>
          <div className="drop-overlay-inner">
            <FileUp size={40} strokeWidth={1.5} />
            <p>Drop PDFs or images to upload</p>
          </div>
        </div>
      )}
      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}
