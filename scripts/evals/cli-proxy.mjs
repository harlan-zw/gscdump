// Observe real CLI calls. Refuse changes outside the disposable test environment.
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import process from 'node:process'

const args = process.argv.slice(2)
const settings = JSON.parse(readFileSync(process.env.EVAL_SETTINGS, 'utf8'))
const began = Date.now()
const prior = readFileSync(settings.trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const top = args[0]
const allowed = ['query', 'sync', 'dump', 'analyze', 'report'].includes(top)
  || (top === 'auth' && args[1] === 'status')
  || (top === 'store' && !args.some(arg => ['reset', 'rm-site', 'gc', 'compact', 'export', 'rollups'].includes(arg)))
  || (top === 'sites' && !args.some(arg => ['add', 'delete', 'verify', 'verify-token'].includes(arg)) && (args.length === 1 || args[1].startsWith('--')))
  || (top === 'bing' && ['sites', 'status', 'dump'].includes(args[1]))
  || (top === 'indexing' && args[1] === 'quota')
  || (args.length === 1 && ['--help', '--version'].includes(top))
  || args.includes('--help')
const value = flag => args[args.indexOf(flag) + 1]
let reason = !allowed ? 'This operation is outside the evaluation scope.' : null
if (args.some(arg => ['--config-dir', '--profile', '--sql', '--all-sites', '--data-dir', '--api-key', '--api-root', '--output'].some(flag => arg === flag || arg.startsWith(`${flag}=`))))
  reason = 'The evaluation configuration cannot be overridden.'
if (args.some(arg => arg.startsWith('--') && arg.includes('=')))
  reason = 'Use separate flag values in this evaluation.'
if (args.includes('--site') && value('--site') !== settings.site)
  reason = 'The Site is outside the evaluation scope.'
if (args.includes('--out') && value('--out') !== './export')
  reason = 'Exports must use ./export in this evaluation.'
if (top === 'sync' && !args.includes('--status') && !args.includes('--help')) {
  if (prior.some(call => call.code !== 126 && call.args[0] === 'sync' && !call.args.includes('--status') && !call.args.includes('--help')))
    reason = 'Only one sync is allowed per trial.'
  if (value('--start') !== settings.start || value('--end') !== settings.end || value('--tables') !== 'pages')
    reason = 'Sync must use the requested dates and pages table.'
}
if (prior.length >= 20)
  reason = 'The trial reached its CLI command limit.'
const result = reason
  ? { status: 126, stdout: '', stderr: reason }
  : spawnSync(process.execPath, [settings.cli, ...args], { encoding: 'utf8', env: settings.env, timeout: 180_000, maxBuffer: 8_000_000 })
const redact = value => settings.secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), value ?? '')
const entry = { startedAt: new Date(began).toISOString(), durationMs: Date.now() - began, args, code: result.status ?? 1, stdout: redact(result.stdout), stderr: redact(result.stderr) }
appendFileSync(settings.trace, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
process.stdout.write(result.stdout ?? '')
process.stderr.write(result.stderr ?? '')
process.exitCode = entry.code
