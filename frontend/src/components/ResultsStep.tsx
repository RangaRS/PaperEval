import { Download, LoaderCircle, Square, TriangleAlert } from 'lucide-react'
import { useState } from 'react'

import { api, type DocumentInfo, type EvaluationSummary, type Exam } from '../api'
import { classStats, formatMarks, questionLabel } from '../exams'
import { downloadBlob, errorMessage, pluralize } from '../utils'

/** Step 3 of an evaluator: every student's marks for each question, with a CSV download. */
export function ResultsStep({
  exam,
  evaluations,
  active,
  documents,
  onOpenPaper,
  onStopRuns,
  onError,
  unsaved,
}: {
  exam: Exam
  evaluations: EvaluationSummary[]
  active: string[]
  documents: DocumentInfo[]
  onOpenPaper: (documentId: string) => void
  onStopRuns: (documentIds: string[]) => void
  onError: (message: string) => void
  unsaved: boolean
}) {
  const [downloading, setDownloading] = useState(false)
  const stats = classStats(evaluations)

  const downloadCsv = async () => {
    setDownloading(true)
    try {
      downloadBlob(`${exam.name} results.csv`, await api.resultsCsv(exam.id))
    } catch (error) {
      onError(`Could not download the results: ${errorMessage(error)}`)
    } finally {
      setDownloading(false)
    }
  }
  const rows = [...evaluations].sort(
    (a, b) =>
      Number(!a.roll_number) - Number(!b.roll_number) ||
      a.roll_number.localeCompare(b.roll_number, undefined, { numeric: true, sensitivity: 'base' }) ||
      a.student_name.localeCompare(b.student_name, undefined, { numeric: true, sensitivity: 'base' }) ||
      a.document_name.localeCompare(b.document_name, undefined, { numeric: true, sensitivity: 'base' }),
  )
  const names = new Map(documents.map((document) => [document.id, document.filename]))

  return (
    <>
      <div className="exam-toolbar">
        <span className="results-stats">
          {stats
            ? `${pluralize(stats.count, 'paper')} · average ${formatMarks(stats.average)} · highest ${formatMarks(stats.highest)} · lowest ${formatMarks(stats.lowest)}`
            : 'No papers evaluated yet'}
        </span>
        <div className="toolbar-group">
          <button
            type="button"
            className="btn btn-small"
            onClick={() => void downloadCsv()}
            disabled={evaluations.length === 0 || downloading}
            title="Everyone's marks for each question, for Excel or Google Sheets"
          >
            {downloading ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Download size={14} aria-hidden />}
            Download CSV
          </button>
        </div>
      </div>
      {unsaved && (
        <p className="hint results-note">The table uses the saved questions. Save your changes to see them here.</p>
      )}
      {active.length > 0 && (
        <div className="results-running" role="status">
          <LoaderCircle size={15} className="spin" aria-hidden />
          <span>
            Evaluating {active.length === 1 ? (names.get(active[0]) ?? '1 paper') : `${active.length} papers`}…
          </span>
          <button type="button" className="btn btn-small" onClick={() => onStopRuns(active)}>
            <Square size={12} aria-hidden />
            Stop
          </button>
        </div>
      )}
      {rows.length === 0 ? (
        <div className="exam-empty">
          <p>Everyone's marks appear here, question by question, as the answer papers in step 2 are marked.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="results-table">
            <thead>
              <tr>
                <th>Student</th>
                <th>Roll no.</th>
                <th>Paper</th>
                {exam.questions.map((question, index) => (
                  <th key={question.id} className="num">
                    {questionLabel(question.number, index)}
                    <span className="th-max">/{formatMarks(question.max_marks)}</span>
                  </th>
                ))}
                <th className="num">
                  Total<span className="th-max">/{formatMarks(exam.total_marks)}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((evaluation) => {
                const answers = new Map(evaluation.answers.map((answer) => [answer.question_id, answer]))
                return (
                  <tr
                    key={evaluation.id}
                    tabIndex={0}
                    onClick={() => onOpenPaper(evaluation.document_id)}
                    onKeyDown={(event) => event.key === 'Enter' && onOpenPaper(evaluation.document_id)}
                    title="Open this paper"
                  >
                    <td>{evaluation.student_name || <span className="muted">Not found</span>}</td>
                    <td>{evaluation.roll_number || <span className="muted">–</span>}</td>
                    <td className="results-paper">{evaluation.document_name}</td>
                    {exam.questions.map((question) => {
                      const answer = answers.get(question.id)
                      const marks = answer?.marks
                      return (
                        <td
                          key={question.id}
                          className={`num${answer?.status === 'unanswered' ? ' is-unanswered' : ''}`}
                          title={answer?.status === 'unanswered' ? 'Not answered' : undefined}
                        >
                          {marks === null || marks === undefined ? '–' : formatMarks(marks)}
                        </td>
                      )
                    })}
                    <td className="num results-total">
                      {formatMarks(evaluation.marks)}
                      {!evaluation.complete && (
                        <TriangleAlert
                          size={13}
                          className="results-incomplete"
                          aria-label="Some answers have no marks"
                        />
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
