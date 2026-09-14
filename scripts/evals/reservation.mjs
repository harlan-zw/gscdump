import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'

export async function reserve(directory, request, maxCalls = 20) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const lock = join(directory, 'lock')
  const deadline = Date.now() + 10_000
  for (;;) {
    const acquired = await mkdir(lock).then(() => true).catch((error) => {
      if (error.code === 'EEXIST')
        return false
      throw error
    })
    if (acquired)
      break
    if (Date.now() >= deadline)
      throw new Error('Timed out reserving a CLI call. Inspect the trial lock.')
    await setTimeout(20)
  }
  try {
    const journal = join(directory, 'reservations.jsonl')
    const text = await readFile(journal, 'utf8').catch((error) => {
      if (error.code === 'ENOENT')
        return '' // No calls have been reserved yet.
      throw error
    })
    const prior = text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    let reason = request.reason
    if (prior.length >= maxCalls)
      reason = 'The trial reached its CLI command limit.'
    if (request.sync && prior.some(call => call.sync && call.reason === null))
      reason = 'Only one sync is allowed per trial.'
    const reservation = { id: randomUUID(), reservedAt: new Date().toISOString(), sync: request.sync, reason }
    await appendFile(journal, `${JSON.stringify(reservation)}\n`, { mode: 0o600 })
    return reservation
  }
  finally {
    await rmdir(lock)
  }
}
