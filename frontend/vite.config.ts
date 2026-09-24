/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { defineConfig } from 'vite'

// The ports are set in backend/.env, like the rest of the settings, so that the
// backend and this dev server agree on them. Environment variables win.
function readBackendEnv(): Record<string, string | undefined> {
  try {
    const text = readFileSync(new URL('../backend/.env', import.meta.url), 'utf8')
    // Some Windows editors start the file with a byte order mark.
    return parseEnv(text.replace(/^\uFEFF/, ''))
  } catch {
    return {} // No backend/.env: use the defaults.
  }
}

const backendEnv = readBackendEnv()
const setting = (name: string, fallback: string) => process.env[name]?.trim() || backendEnv[name]?.trim() || fallback

// The FastAPI backend (`python -m app`). During development Vite forwards /api requests to it.
const backendHost = setting('BACKEND_HOST', '127.0.0.1')
const backend = setting(
  'BACKEND_URL',
  `http://${['0.0.0.0', '::', 'localhost'].includes(backendHost) ? '127.0.0.1' : backendHost}:${setting('BACKEND_PORT', '8710')}`,
)

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(setting('FRONTEND_PORT', '5710')),
    proxy: { '/api': { target: backend, changeOrigin: true } },
  },
  preview: {
    proxy: { '/api': { target: backend, changeOrigin: true } },
  },
  test: {
    environment: 'node',
  },
})
