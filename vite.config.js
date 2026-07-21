import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execFileSync } from 'node:child_process'
import process from 'node:process'

function getGitCommitHash() {
  const ciCommitHash =
    process.env.VITE_GIT_COMMIT_HASH ||
    process.env.CF_PAGES_COMMIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.GITHUB_SHA

  if (ciCommitHash) return ciCommitHash

  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'unknown'
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_GIT_COMMIT_HASH': JSON.stringify(getGitCommitHash()),
  },
})
