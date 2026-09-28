import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'
import { run } from './runtime.mjs'

it('regrades a passed runbook trial with the runbook grader, not the generic grader', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gscdump-summarize-'))
  const events = [
    { type: 'tool_use', part: { tool: 'skill', state: { input: { name: 'gscdump' }, status: 'completed' } } },
    { type: 'text', part: { text: 'The page lost clicks in the selected window. Section page-movers, 2026-08-01 to 2026-08-07.' } },
  ]
  const calls = [
    { args: ['report', 'movers', '--vs', 'prev-period', '--json'], code: 0, stdout: '{"id":"movers","site":"sc-domain:example.com","window":{"start":"2026-08-01","end":"2026-08-07"},"sections":[{"id":"page-movers"}],"meta":{"degraded":false}}' },
    { args: ['query', '--dimensions', 'date,page', '--format', 'json'], code: 0, stdout: '{"data":[{"page":"/a","clicks":3}]}' },
  ]
  await writeFile(join(directory, 'report.json'), JSON.stringify({
    site: 'sc-domain:example.com',
    start: '2026-08-01',
    end: '2026-08-07',
    agentTrials: [{ id: 'weekly-triage-1', caseId: 'weekly-triage', kind: 'runbook', trial: 1, shouldTrigger: true }],
  }))
  await writeFile(join(directory, 'weekly-triage-1-calls.json'), JSON.stringify(calls))
  await writeFile(join(directory, 'weekly-triage-1-events.json'), JSON.stringify(events))
  const result = await run(process.execPath, [fileURLToPath(new URL('./summarize.mjs', import.meta.url)), directory])
  assert.equal(result.code, 0, result.stderr)
  const stamp = (await readdir(join(directory, 'regrades'))).at(-1)
  const regrades = JSON.parse(await readFile(join(directory, 'regrades', stamp, 'report.json'), 'utf8'))
  const trial = regrades.trials.find(entry => entry.id === 'weekly-triage-1')
  assert.equal(trial.processGrade.passed, true, JSON.stringify(trial.processGrade.failures))
  assert.equal(trial.answerGrade, null)
})

it('regrades a runbook trial against the recorded case URL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gscdump-summarize-'))
  const events = [
    { type: 'tool_use', part: { tool: 'skill', state: { input: { name: 'gscdump' }, status: 'completed' } } },
    { type: 'text', part: { text: 'Google shows the URL indexed; Bing evidence is dated separately.' } },
  ]
  const calls = [
    { args: ['inspect', '--url', 'https://example.com/case', '--json'], code: 0, stdout: '{"inspected":1,"results":[{"url":"https://example.com/case","status":"inspected"}]}' },
    { args: ['bing', 'inspect', '--url', 'https://example.com/other', '--json'], code: 0, stdout: '{"searchEngine":"bing","url":"https://example.com/other","observedAt":"2026-08-07"}' },
  ]
  await writeFile(join(directory, 'report.json'), JSON.stringify({
    site: 'sc-domain:example.com',
    start: '2026-08-01',
    end: '2026-08-07',
    agentTrials: [{ id: 'google-and-bing-1', caseId: 'google-and-bing', kind: 'runbook', trial: 1, shouldTrigger: true, url: 'https://example.com/case' }],
  }))
  await writeFile(join(directory, 'google-and-bing-1-calls.json'), JSON.stringify(calls))
  await writeFile(join(directory, 'google-and-bing-1-events.json'), JSON.stringify(events))
  const result = await run(process.execPath, [fileURLToPath(new URL('./summarize.mjs', import.meta.url)), directory])
  assert.equal(result.code, 0, result.stderr)
  const stamp = (await readdir(join(directory, 'regrades'))).at(-1)
  const regrades = JSON.parse(await readFile(join(directory, 'regrades', stamp, 'report.json'), 'utf8'))
  const trial = regrades.trials.find(entry => entry.id === 'google-and-bing-1')
  assert.equal(trial.processGrade.passed, false, JSON.stringify(trial.processGrade.failures))
  assert(trial.processGrade.failures.some(failure => failure.includes('Bing')), JSON.stringify(trial.processGrade.failures))
})
