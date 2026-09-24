import { lazy, Suspense, type ReactNode } from 'react'

// Typesetting maths needs KaTeX, so only load it once a preview is shown.
const MathPreview = lazy(() => import('./MathPreview'))

/** Text written by a student or a model: as it is, or formatted with its LaTeX maths typeset. */
export function RichText({ text, preview, empty }: { text: string; preview: boolean; empty?: ReactNode }) {
  if (!text.trim()) return <p className="rich-empty">{empty}</p>
  const plain = <pre className="rich-text">{text}</pre>
  if (!preview) return plain
  return (
    <Suspense fallback={plain}>
      <MathPreview text={text} className="result-preview rich-preview" />
    </Suspense>
  )
}
