import { CloudOff, FileUp, RefreshCw, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { api, type AppConfig, type DocumentInfo, type ModelInfo, type OllamaStatus } from './api'
import { EmptyState } from './components/EmptyState'
import { Header } from './components/Header'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar, type Selection, type UploadProgress } from './components/Sidebar'
import { Toasts } from './components/Toasts'
import { Workspace } from './components/Workspace'
import { isString, useFileDrop, useLocalStorage, useToasts } from './hooks'
import { OcrQueue, pageKey } from './ocrQueue'
import { documentText, downloadText, errorMessage, fileStem } from './utils'

const MB = 1024 * 1024
const isPrompt = (value: unknown): value is string | null => value === null || typeof value === 'string'

/** The model picked earlier if it is still offered, else the configured default, else the first vision model. */
function chooseModel(saved: string, configured: string, models: ModelInfo[]): string {
  const usable = models.filter((model) => model.vision !== false)
  const offered = (name: string) => name !== '' && (models.length === 0 || usable.some((model) => model.name === name))
  if (offered(saved)) return saved
  if (offered(configured)) return configured
  return usable.find((model) => model.vision === true)?.name ?? usable[0]?.name ?? ''
}

function withPageText(documents: DocumentInfo[], documentId: string, pageNumber: number, ocr: DocumentInfo['pages'][number]['ocr']) {
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
  const [documents, setDocuments] = useState<DocumentInfo[]>([])
  const [loadingDocuments, setLoadingDocuments] = useState(true)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [upload, setUpload] = useState<UploadProgress | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [savedModel, setSavedModel] = useLocalStorage('papereval.model', '', isString)
  const [customPrompt, setCustomPrompt] = useLocalStorage<string | null>('papereval.prompt', null, isPrompt)
  const { toasts, notify, dismiss: dismissToast } = useToasts()

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

  const models = status?.models ?? []
  const model = chooseModel(savedModel, config?.default_model ?? '', models)
  const prompt = customPrompt ?? config?.default_prompt ?? ''
  const setPrompt = (value: string) => setCustomPrompt(value === config?.default_prompt ? null : value)

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
      if (!window.confirm(`Delete "${document.filename}" and its extracted text?`)) return
      queue.remove((job) => job.documentId === document.id)
      try {
        await api.deleteDocument(document.id)
      } catch (error) {
        notify(`Could not delete ${document.filename}: ${errorMessage(error)}`)
        return
      }
      const remaining = documents.filter((candidate) => candidate.id !== document.id)
      setDocuments((current) => current.filter((candidate) => candidate.id !== document.id))
      setSelection((current) =>
        current?.documentId !== document.id
          ? current
          : remaining[0]
            ? { documentId: remaining[0].id, pageNumber: 1 }
            : null,
      )
    },
    [queue, notify, documents],
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

  const selectedDocument = documents.find((document) => document.id === selection?.documentId)
  const selectedPage = selectedDocument?.pages.find((page) => page.number === selection?.pageNumber)
  const selectedKey = selectedDocument && selectedPage ? pageKey(selectedDocument.id, selectedPage.number) : ''

  useEffect(() => {
    window.document.title = selectedDocument ? `${selectedDocument.filename} · PaperEval` : 'PaperEval'
  }, [selectedDocument])

  const accepted = config?.accepted_extensions ?? ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff']
  const hasVisionModel = models.some((candidate) => candidate.vision !== false)

  return (
    <div className="app">
      <Header
        status={status}
        checking={checking}
        models={models}
        model={model}
        onModelChange={setSavedModel}
        onRefresh={refreshStatus}
        onOpenSettings={() => setSettingsOpen(true)}
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
      {status?.reachable && !hasVisionModel && (
        <div className="banner banner-warning" role="status">
          <TriangleAlert size={18} aria-hidden />
          <span>
            {status.cloud ? (
              'No vision models are available from Ollama Cloud right now.'
            ) : (
              <>
                No vision models found. Pull one (for example <code>ollama pull qwen2.5vl</code>), or run{' '}
                <code>ollama signin</code> to use Ollama Cloud models.
              </>
            )}
          </span>
        </div>
      )}

      <div className="main">
        <Sidebar
          documents={documents}
          loading={loadingDocuments}
          jobs={jobs}
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
        />
        <main className="content">
          {selectedDocument && selectedPage ? (
            <Workspace
              document={selectedDocument}
              page={selectedPage}
              job={jobs.get(selectedKey)}
              model={model}
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
        onClose={() => setSettingsOpen(false)}
        config={config}
        status={status}
        prompt={prompt}
        onPromptChange={setPrompt}
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
