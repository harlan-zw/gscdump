// Observe real CLI calls. Refuse changes outside the disposable test environment.
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { checkScope } from './policy.mjs'
import { reserve } from './reservation.mjs'

const args = process.argv.slice(2)
const settings = JSON.parse(readFileSync(process.env.EVAL_SETTINGS, 'utf8'))
const queuedAt = new Date().toISOString()
const reservation = await reserve(settings.reservations, { ...checkScope(args, settings), args })
const reason = reservation.reason
const began = Date.now()
const result = reason
  ? { status: 126, stdout: '', stderr: reason }
  : spawnSync(process.execPath, [settings.cli, ...args], { encoding: 'utf8', env: settings.env, timeout: 180_000, maxBuffer: 8_000_000 })
const redact = value => settings.secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), value ?? '')
const entry = { reservationId: reservation.id, queuedAt, finishedAt: new Date().toISOString(), startedAt: new Date(began).toISOString(), durationMs: Date.now() - began, args, code: result.status ?? 1, stdout: redact(result.stdout), stderr: redact(result.error ? `${result.stderr ?? ''}\n${result.error.message}` : result.stderr) }
appendFileSync(settings.trace, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
process.stdout.write(result.stdout ?? '')
process.stderr.write(entry.stderr)
process.exitCode = entry.code
