import { spawn } from 'node:child_process'
import process from 'node:process'

const env = { ...process.env }
// The suites read GSC names first. Normalize fallbacks before passing the environment.
for (const suffix of ['ACCESS_TOKEN', 'CLIENT_ID', 'CLIENT_SECRET', 'REFRESH_TOKEN']) {
  const name = `GSC_${suffix}`
  const value = env[name] || env[`GOOGLE_${suffix}`]
  if (value)
    env[name] = value
  else
    delete env[name]
}
const accessToken = env.GSC_ACCESS_TOKEN || env.GOOGLE_ACCESS_TOKEN
const refreshCredentials = (env.GSC_CLIENT_ID || env.GOOGLE_CLIENT_ID)
  && (env.GSC_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET)
  && (env.GSC_REFRESH_TOKEN || env.GOOGLE_REFRESH_TOKEN)
if (!accessToken && !refreshCredentials) {
  console.error('Live checks need GSC_ACCESS_TOKEN or GSC_CLIENT_ID, GSC_CLIENT_SECRET, and GSC_REFRESH_TOKEN.')
  process.exitCode = 1
}
else {
  const child = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', [
    'exec',
    'vitest',
    'run',
    '--config',
    'tests/e2e/vitest.config.ts',
    'pipeline-real',
    'sites-real',
  ], { stdio: 'inherit', env })
  child.once('error', (error) => {
    console.error(error.message)
    process.exitCode = 1
  })
  child.once('exit', (code) => {
    process.exitCode = code ?? 1
  })
}
