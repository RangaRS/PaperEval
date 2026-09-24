import 'katex/dist/katex.min.css'

import { useDeferredValue } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

import { normalizeMath } from '../mathText'

const remarkPlugins = [remarkGfm, remarkMath, remarkBreaks]
// Broken LaTeX is shown as red source text rather than failing the whole preview.
const rehypePlugins: [typeof rehypeKatex, Parameters<typeof rehypeKatex>[0]][] = [[rehypeKatex, { strict: 'ignore' }]]

/** The extracted text rendered as Markdown, with its LaTeX maths typeset. */
export default function MathPreview({ text, className = 'result-preview' }: { text: string; className?: string }) {
  // While text streams in, let React skip renders it cannot keep up with.
  const deferredText = useDeferredValue(text)
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        // Don't fetch images a model might mention in its answer.
        disallowedElements={['img']}
        unwrapDisallowed
      >
        {normalizeMath(deferredText)}
      </ReactMarkdown>
    </div>
  )
}
