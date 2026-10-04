import { ClipboardCheck, Network, Plus, Sparkles } from 'lucide-react'

interface WelcomeProps {
  loading: boolean
  onLoadSample: () => void
  onOpenStructure: () => void
  onCreate: () => void
}

/** Shown before anything is set up: what the app does, and three ways to start. */
export function Welcome({ loading, onLoadSample, onOpenStructure, onCreate }: WelcomeProps) {
  return (
    <div className="welcome">
      <div className="welcome-intro">
        <ClipboardCheck size={40} strokeWidth={1.5} aria-hidden />
        <h2>Mark answer papers with AI</h2>
        <p className="muted">
          Upload a subject's question paper with its answer key, then the students' answer papers. Every answer is read
          and marked against the key, and you check each mark next to the student's handwriting.
        </p>
      </div>
      <div className="welcome-options">
        <button type="button" className="welcome-option is-featured" onClick={onLoadSample} disabled={loading}>
          <Sparkles size={22} aria-hidden />
          <span className="welcome-option-title">Explore a sample college</span>
          <span className="welcome-option-text">
            Departments, programmes, semesters, subjects and exam sittings, set up and ready to try.
          </span>
        </button>
        <button type="button" className="welcome-option" onClick={onOpenStructure} disabled={loading}>
          <Network size={22} aria-hidden />
          <span className="welcome-option-title">Set up your college</span>
          <span className="welcome-option-text">
            Add your departments, programmes and the subjects of each semester, then mark each subject's papers.
          </span>
        </button>
        <button type="button" className="welcome-option" onClick={onCreate} disabled={loading}>
          <Plus size={22} aria-hidden />
          <span className="welcome-option-title">Just mark one test</span>
          <span className="welcome-option-text">
            Create a single evaluator for a quick test. You can file it under a subject later.
          </span>
        </button>
      </div>
    </div>
  )
}
