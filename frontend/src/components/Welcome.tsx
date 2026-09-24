import { ClipboardCheck, Plus } from 'lucide-react'

/** Shown while there is no evaluator: what the app does, and how to start. */
export function Welcome({ loading, onCreate }: { loading: boolean; onCreate: () => void }) {
  return (
    <div className="empty-state welcome">
      <ClipboardCheck size={40} strokeWidth={1.5} aria-hidden />
      <h2>Mark answer papers with AI</h2>
      <ol className="welcome-steps">
        <li>
          <strong>Create an evaluator</strong> and upload the question paper with its answer key. The text of every page
          is extracted, and the AI lists each question with its model answer, marking key and marks. You can check and
          correct them.
        </li>
        <li>
          <strong>Upload the students' answer papers</strong> into it, one PDF per student. Each one is read page by
          page, split into answers, and every answer is marked against the key.
        </li>
        <li>
          <strong>Check the marks</strong> next to each paper's pages, change any you disagree with, and download
          everyone's results.
        </li>
      </ol>
      <button type="button" className="btn btn-primary btn-large" onClick={onCreate} disabled={loading}>
        <Plus size={16} aria-hidden />
        New evaluator
      </button>
    </div>
  )
}
