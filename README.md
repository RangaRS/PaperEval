# PaperEval

Mark answer scripts with AI. Upload each student's script as a PDF or images, and PaperEval extracts the text of
every page with an [Ollama](https://ollama.com) vision model, splits the script into the answers to the exam's
questions, and marks each answer against your answer key: the questions with their model answers, marking scheme
and marks. You check every mark next to the student's handwriting and change any you disagree with. Works with
**Ollama Cloud** models or a local Ollama.

![PaperEval: the script on the left, its answers and marks on the right](docs/evaluation.png)

## Features

- **Answer keys.** Each question has its number, the question, a model answer, a marking key (which points or steps
  earn how many marks) and its maximum marks. Type them in, have a model read them from an uploaded answer key, or
  import them from a JSON file. They are stored as JSON, and you can export them.
- **AI evaluation.** Evaluating a script extracts the text of any pages that have none, has a model split the text
  into the answers to the key's questions (students may answer in any order, across pages), and marks every answer
  against its model answer and marking key, a few at a time. Unanswered questions get 0. Evaluate one paper, or a
  whole class at once.
- **Review the marks side by side.** Each answer is shown with its marks, the model's feedback and the pages it is
  on: click a page to see the student's handwriting next to it. Change any mark, correct an answer the text
  extraction got wrong and have it marked again, or fix the student's name and roll number.
- **Class results.** A table of every student's marks per question, with the average, highest and lowest totals,
  and a CSV download for Excel or Google Sheets.
- **Upload PDFs and images** (PNG, JPEG, WebP, GIF, BMP, TIFF) by picking them or dropping them anywhere on the page.
  PDFs are split into one image per page, and multi-page TIFFs into one image per frame. Phone photos are turned
  upright using their EXIF orientation.
- **An Extract button for every page.** It sends that page image to the selected Ollama vision model. The text
  streams in as the model writes it, and you can stop a run at any time. **Extract all** queues every page that
  has no text yet. Pages are read one at a time.
- **Side-by-side comparison.** The page image is on the left (fit width or page, zoom with the buttons or
  Ctrl/⌘ + scroll, drag to pan). The text is on the right (copy, download as `.txt`, monospace toggle).
  Drag the divider between them to resize.
- **Maths preview.** Switch the text panel from **Text** to **Preview** to see the answer formatted, with its LaTeX
  maths typeset (`$...$`, `$$...$$`, `\(...\)` and `\[...\]`). Copy and download still give the LaTeX source.
- **Ollama Cloud or local.** The model lists come from the server, and you can add any other model by name.
  The list at the top, which chooses the model that reads pages, hides models that can't read images. Thinking
  models have their reasoning turned off so they answer straight away.
- **Everything is kept.** Pages, extracted text, answer keys and marks are saved on disk, so they are still there
  after a restart. You can download all of a document's text as one file.
- **Choose the prompt.** Use the *Plain text*, *Markdown* or *Maths (LaTeX)* preset, or write your own in Settings.
  *Maths (LaTeX)* asks the model to write every formula in LaTeX, which suits the preview.

![Extracting text: the page image on the left, the extracted text on the right](docs/screenshot.png)

## How it works

```
React (Vite) ──/api──▶ FastAPI backend ──▶ Ollama Cloud (https://ollama.com) or a local Ollama
                        ├─ splits PDFs with PDFium and images with Pillow
                        ├─ reads each page with a vision model (OCR)
                        ├─ splits a script's text into answers and marks them, asking the model for JSON
                        ├─ stores pages, text, answer keys and marks in backend/data/
                        └─ streams progress back as NDJSON
```

The browser never talks to Ollama directly, so your API key stays on the server.

## Requirements

- Python 3.10 or newer
- Node.js 20.19+ or 22.12+
- Either an Ollama account with an API key (for Ollama Cloud) or Ollama installed locally

## Quick start with Ollama Cloud

1. **Create an API key** at <https://ollama.com/settings/keys>.

2. **Start the backend:**

   ```bash
   cd backend
   python -m venv .venv
   source .venv/bin/activate          # Windows: .venv\Scripts\activate
   pip install -r requirements.txt
   cp .env.example .env               # then put your key in .env: OLLAMA_API_KEY=...
   python -m app
   ```

   The backend reads `backend/.env` when it starts. It runs on <http://localhost:8710>, its API docs are at
   <http://localhost:8710/docs>, and it restarts by itself when its code changes, for example after a `git pull`.
   When it starts, it prints which Ollama it uses: `Using Ollama Cloud at https://ollama.com (with an API key)`
   means your key was found. (`uvicorn app.main:app --reload --port 8710` works too.)

3. **Start the frontend** in a second terminal:

   ```bash
   cd frontend
   npm ci
   npm run dev
   ```

   `npm ci` installs exactly the versions listed in `package-lock.json` and never changes that file, so later
   `git pull`s aren't blocked by local changes to it.

4. Open <http://localhost:5710>, choose a vision model at the top (for example `qwen3-vl:235b`), upload a file,
   and press **Extract** on a page. To mark scripts, see [Marking answer scripts](#marking-answer-scripts).

### Ports

The backend listens on port **8710** and the frontend's dev server on port **5710**, which forwards `/api` requests
to the backend. If another program already uses one of them, choose others in `backend/.env` and restart both:

```
BACKEND_PORT=8720
FRONTEND_PORT=5720
```

The frontend's dev server reads `backend/.env` too, so it always knows where the backend is.

### Two ways to use cloud models

| | Ollama Cloud API | Local Ollama, signed in |
|---|---|---|
| Setup | Set `OLLAMA_API_KEY` | Run `ollama signin` |
| `OLLAMA_BASE_URL` | `https://ollama.com` (the default when a key is set) | `http://localhost:11434` (the default) |
| Model names | as listed by ollama.com, e.g. `qwen3-vl:235b` | with a `-cloud` suffix, e.g. `qwen3-vl:235b-cloud` |

Both work without code changes. The backend can also use ordinary local models, such as `ollama pull qwen2.5vl`.

### Adding models to the list

The model list shows the vision models your Ollama server reports. To use a model that isn't listed:

- **In the app:** choose **+ Add a model…** at the bottom of the model list (or open **Settings → Models**), type the
  model's exact name and press **Add**. It is selected right away and saved in your browser. Remove it from the same
  place in Settings.
- **As the default for everyone:** set `OLLAMA_MODEL` in `backend/.env`. It always appears in the list and is used
  until someone picks another model.
- **With a local Ollama:** `ollama pull <model>` (for example `ollama pull qwen3-vl:235b-cloud`) makes it appear in
  the list by itself.

With an API key the app talks to ollama.com directly, where cloud models are named without the `-cloud` suffix
that ollama.com shows (for example `qwen3-vl:235b` rather than `qwen3-vl:235b-cloud`). The app removes that
suffix for you, so either name works. A model you choose is always tried, even if the server's information says it
cannot read images.

For example, Gemma 4 on Ollama Cloud is `gemma4:31b-cloud` (`gemma4:31b` on the API). Names such as `gemma4`,
`gemma4:latest` or `gemma4:cloud` don't exist there. When a model isn't found, the error suggests similar names
that the server does offer.

## Marking answer scripts

1. **Create an answer key.** Open the **Answer keys** tab and press **New answer key**, then fill in each question:
   its number, the question, the model answer, the marking key and its marks. Or:
   - **From a document:** upload the answer key (a question paper with answers and a marking scheme). The text of
     every page is extracted first, one page at a time, and then all of it goes to a model, which lists each
     question with its answer, marking scheme and marks. The dialog shows each page's progress and how much the
     model has written. If the model finds no questions, the dialog shows what it answered and the text it was
     sent, so you can see why. Check what it read, and set any marks it missed.
   - **Import JSON:** load a file in the [answer key format](#answer-key-format).

   Write maths in LaTeX (`$\frac{a}{b}$`); **Preview** shows it typeset. Every question needs its marks before
   scripts can be evaluated. Press **Save** (or Ctrl+S).

   ![An answer key, with its maths previewed](docs/answer-key.png)
2. **Upload the scripts** in the **Papers** tab, one file per student (a PDF, or images of the pages).
3. **Evaluate.** Open a paper, switch the right-hand side to **Marks** and press **Evaluate this paper**. To evaluate
   many papers at once, open the answer key's **Results** tab and press **Evaluate papers…**. Choose the answer key
   and a model for marking. Pages without text are first read with the vision model chosen at the top, using the
   prompt from Settings (choose *Maths (LaTeX)* for maths papers). Papers are evaluated one after another.
4. **Check the marks.** Each answer shows its marks, the model's feedback and its pages; click a page to see it on
   the left. Type another number to change a mark (**Undo** goes back to the AI's), **Correct the answer** when the
   text was read wrong (it is then marked again), or **Mark again** to have it re-marked. **Question and marking key**
   shows what the answer was marked against. Marks changed by you count instead of the AI's in the totals.
5. **Get the results.** The answer key's **Results** tab lists every paper evaluated with it; **Download CSV** saves
   the marks per question, the totals and each student's name and roll number.

   ![The class results](docs/results.png)

If an evaluation is stopped part way (or a model fails), the answers marked so far are kept and **Mark them**
finishes the rest. Evaluating a paper again with the same answer key replaces its marks, including ones you changed.

**Which models?** The pages are read by the vision model chosen at the top (for example `qwen3-vl:235b`). Splitting
and marking work on text, so any model can do them; a large model follows the marking key best, for example
`gpt-oss:120b` or `qwen3.5:397b` on Ollama Cloud. The Evaluate dialog remembers your choice, and **Mark again** uses
it too. AI marks are suggestions: check them before you use them.

### Answer key format

An answer key is saved as `backend/data/exams/<id>.json`, and **Export** / **Import JSON** use this format:

```json
{
  "name": "Mathematics — Unit Test 1",
  "questions": [
    {
      "number": "1",
      "question": "Solve $px + qy = 3z$.",
      "answer": "The auxiliary equations are $\\frac{dx}{x} = \\frac{dy}{y} = \\frac{dz}{3z}$, so $\\phi(x/y, y^3/z) = 0$.",
      "key": "Auxiliary equations: 1 mark. General solution: 1 mark.",
      "max_marks": 2
    }
  ]
}
```

`key` is the marking scheme: which points or steps earn how many marks. Import also accepts a plain list of
questions, and `marks`, `model_answer` or `marking_scheme` as field names.

## Updating

```bash
git pull
cd frontend
npm ci                                  # only needed when package.json changed
cd ../backend
pip install -r requirements.txt         # only needed when requirements.txt changed
```

Stop `npm run dev` before running `npm ci`: on Windows, the running dev server keeps files open and the reinstall
fails. If `git pull` says your local changes to `frontend/package-lock.json` would be overwritten, an earlier
`npm install` rewrote that file. Discard the change with `git restore frontend/package-lock.json` and pull again.

## Running as a single server

Build the frontend once. When `frontend/dist` exists, the backend serves the app itself:

```bash
cd frontend && npm run build
cd ../backend && python -m app --no-reload
```

Then open <http://localhost:8710>. To reach it from other machines, add `--host 0.0.0.0` (or set
`BACKEND_HOST=0.0.0.0`).

## Configuration

Set these in `backend/.env` or as environment variables (which take precedence). Restart the backend after
changing them.

| Variable | Default | Description |
|---|---|---|
| `BACKEND_PORT` | `8710` | Port the backend listens on (`python -m app`). |
| `FRONTEND_PORT` | `5710` | Port of the frontend's dev server (`npm run dev`). |
| `BACKEND_HOST` | `127.0.0.1` | Address the backend listens on. `0.0.0.0` makes it reachable from other machines. |
| `OLLAMA_API_KEY` | | API key for Ollama Cloud, sent as a Bearer token. |
| `OLLAMA_BASE_URL` | `https://ollama.com` if a key is set, otherwise `http://localhost:11434` | The Ollama server to use. |
| `OLLAMA_MODEL` | | Model to use when none is chosen in the UI. |
| `OLLAMA_TIMEOUT` | `600` | Seconds to wait for Ollama to send the next part of a response. |
| `OLLAMA_NUM_CTX` | `0` | Context window to request from a local model. `0` leaves it to the server. |
| `OCR_MAX_IMAGE_SIDE` | `2048` | Pages are scaled down to this many pixels on their longest side before they are sent to the model. `0` sends them at full size. |
| `PDF_DPI` | `200` | Resolution for rendering PDF pages. |
| `MAX_UPLOAD_MB` | `50` | Largest file you can upload. |
| `MAX_PAGES` | `200` | Most pages a single upload can have. |
| `GRADING_CONCURRENCY` | `3` | How many answers of a script are marked at the same time. Lower it if Ollama reports rate limits. |
| `DATA_DIR` | `backend/data` | Where documents, answer keys and marks are stored. |
| `FRONTEND_DIST` | `frontend/dist` | The frontend build to serve, if it exists. |

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/ollama` | Connection status and available models, marked with whether they can read images |
| `GET` | `/api/config` | Default model, prompt presets and upload limits |
| `POST` | `/api/documents` | Upload a PDF or image (multipart field `file`) and split it into pages |
| `GET` | `/api/documents` | All documents, newest first |
| `GET` | `/api/documents/{id}` | One document, including its pages and their results |
| `DELETE` | `/api/documents/{id}` | Delete a document |
| `GET` | `/api/documents/{id}/pages/{n}/image` | Page image; `/thumbnail` gives a small preview |
| `POST` | `/api/documents/{id}/pages/{n}/ocr` | Extract a page's text; body `{"model": "...", "prompt": "..."}`, both optional |

The OCR endpoint streams [NDJSON](https://github.com/ndjson/ndjson-spec) events:

```
{"type": "start", "model": "qwen3-vl:235b"}
{"type": "thinking"}
{"type": "chunk", "text": "PHYSICS 101 — "}
{"type": "done", "result": {"text": "...", "model": "...", "duration_ms": 4300, "truncated": false, ...}}
{"type": "error", "message": "Ollama refused the request (HTTP 401: unauthorized). Check that OLLAMA_API_KEY ..."}
```

`thinking` is only sent if the model reasons before answering. A run ends with either `done` or `error`.
Closing the connection stops the model.

Answer keys and evaluations:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/exams` | All answer keys, with their number of questions and total marks |
| `POST` | `/api/exams` | Create an answer key; body `{"name": "...", "questions": [...]}` |
| `POST` | `/api/exams/from-document` | Read an answer key from a document whose pages have text; body `{"document_id": "...", "model": "..."}`. Streams NDJSON: `start`, `progress`, then `done` with the answer key or `error` with the model's answer |
| `GET` `PUT` `DELETE` | `/api/exams/{id}` | One answer key; deleting it also deletes the marks given with it |
| `GET` | `/api/exams/{id}/results.csv` | Every evaluated script's marks, as CSV |
| `POST` | `/api/documents/{id}/evaluations` | Evaluate a script; body `{"exam_id": "...", "model": "..."}`. Streams NDJSON |
| `GET` | `/api/evaluations` | Summaries of all evaluations; filter with `?document_id=` or `?exam_id=` |
| `GET` `PATCH` `DELETE` | `/api/evaluations/{id}` | One evaluation; `PATCH` corrects `student_name` or `roll_number` |
| `PATCH` | `/api/evaluations/{id}/answers/{question_id}` | Set `teacher_marks` (null goes back to the AI's) or correct the `answer` text |
| `POST` | `/api/evaluations/{id}/grade` | Mark answers again; body `{"model": "...", "question_ids": [...]}`, where no ids means every answer without marks. Streams NDJSON |

An evaluation streams these events:

```
{"type": "status", "step": "split"}
{"type": "split", "evaluation": {"student_name": "Asha K", "answers": [{"question_id": "...", "status": "pending", ...}], ...}}
{"type": "answer", "answer": {"question_id": "...", "status": "graded", "ai_marks": 2, "feedback": "...", ...}}
{"type": "done", "evaluation": {..., "marks": 7.5, "max_marks": 10, "complete": true}}
```

or an `error` event. While the script is split, `progress` events say how much the model has written. Rate limits
and overloaded servers are retried twice; an invalid key, a model outside your plan or an unknown model stops the
evaluation, and the answers not yet marked can be marked later.

The models are asked for JSON in a set shape, but their answers are read leniently: a bare list, sections such as
Part A and Part B, sub-questions and other field names all work. An answer that can't be used is asked for once
more without a JSON schema, since some servers ignore the schema and models sometimes give up inside one.

## Development

```bash
# Backend: tests and lint
cd backend
pip install -r requirements-dev.txt
pytest
ruff check . && ruff format --check .

# Frontend: unit tests, type check and lint
cd frontend
npm test
npm run typecheck
npm run lint
```

In development, Vite sends `/api` requests to the backend at the port set in `backend/.env` (8710 by default). To
use another address, set `BACKEND_URL` when you run `npm run dev`.

## Project layout

```
backend/
  app/
    __main__.py   `python -m app`: starts the backend on the configured port
    main.py       app factory, serves the frontend build
    api.py        HTTP routes
    pages.py      splitting PDFs and images into page images
    storage.py    documents, page images and OCR results on disk
    ollama.py     Ollama / Ollama Cloud client, including JSON answers
    ocr.py        prompts and the streamed OCR run
    exams.py      answer keys on disk
    grading.py    prompts for reading answer keys, splitting scripts and marking answers
    evaluations.py  evaluations on disk and the streamed evaluation run
    grading_api.py  HTTP routes for answer keys and evaluations
    llm_json.py   reads JSON written by a model, keeping LaTeX intact
    config.py     settings from environment variables
  tests/
frontend/
  src/
    App.tsx       app state: documents, answer keys, evaluations, selection, models
    ocrQueue.ts   runs OCR jobs one at a time and tracks their progress
    evaluationRunner.ts  runs evaluations one at a time and tracks their progress
    exams.ts      answer key helpers: import, export, totals
    api.ts        typed API client
    components/   sidebar, split view, image viewer, text and marks panels, answer key editor, dialogs
```
