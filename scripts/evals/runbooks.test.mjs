import assert from 'node:assert/strict'
import { it } from 'vitest'
import { gradeRunbook, RUNBOOK_CASES, runbookBlock } from './runbooks.mjs'

it('requires a completed Report and source-row check for traffic triage', () => {
  const definition = RUNBOOK_CASES.find(test => test.id === 'weekly-triage')
  const calls = [
    { args: ['report', 'movers', '--vs', 'prev-period', '--json'], code: 0, stdout: '{"id":"movers","site":"sc-domain:example.com","window":{"start":"2026-08-01","end":"2026-08-07"},"sections":[{"id":"page-movers"}],"meta":{"degraded":false}}' },
    { args: ['query', '--dimensions', 'date,page', '--format', 'json'], code: 0, stdout: '{"data":[{"page":"/a","clicks":3}]}' },
  ]
  assert.equal(gradeRunbook({ definition, calls, loaded: true, text: 'The page lost clicks in the selected window.', expected: { site: 'sc-domain:example.com' } }).passed, true)
  assert.equal(gradeRunbook({ definition, calls: calls.slice(0, 1), loaded: true, text: 'The page lost clicks.' }).passed, false)
  assert.equal(gradeRunbook({ definition, calls: [{ ...calls[0], args: ['report', 'movers', '--json'] }, calls[1]], loaded: true, text: 'The page lost clicks.' }).passed, false)
  assert.equal(gradeRunbook({ definition, calls: [{ ...calls[0], stdout: '{}' }, calls[1]], loaded: true, text: 'The page lost clicks.' }).passed, false)
})

it('grades the completed JSON run instead of an earlier preview or table run', () => {
  const definition = RUNBOOK_CASES.find(test => test.id === 'weekly-triage')
  const preview = { args: ['report', 'movers', '--vs', 'prev-period', '--explain'], code: 0, stdout: '{"id":"movers","window":{"start":"2026-08-01","end":"2026-08-07"},"plan":[]}' }
  const table = { args: ['report', 'movers', '--vs', 'prev-period'], code: 0, stdout: 'id  movers  window' }
  const completed = { args: ['report', 'movers', '--vs', 'prev-period', '--json'], code: 0, stdout: '{"id":"movers","site":"sc-domain:example.com","window":{"start":"2026-08-01","end":"2026-08-07"},"sections":[{"id":"page-movers"}],"meta":{"degraded":false}}' }
  const sourceRows = { args: ['query', '--dimensions', 'date,page', '--format', 'json'], code: 0, stdout: '{"data":[{"page":"/a","clicks":3}]}' }
  const input = { definition, loaded: true, text: 'The page lost clicks.', expected: { site: 'sc-domain:example.com' } }
  assert.equal(gradeRunbook({ ...input, calls: [preview, completed, sourceRows] }).passed, true)
  assert.equal(gradeRunbook({ ...input, calls: [table, completed, sourceRows] }).passed, true)
  assert.equal(gradeRunbook({ ...input, calls: [preview, sourceRows] }).passed, false)
})

it('blocks the Bing runbook when the trial env keeps no Bing credential', () => {
  const definition = RUNBOOK_CASES.find(test => test.id === 'google-and-bing')
  assert.match(runbookBlock(definition, { GSCDUMP_API_KEY: 'hosted' }), /Bing credentials are missing/)
  assert.equal(runbookBlock(definition, { BING_API_KEY: 'bing' }), null)
  assert.equal(runbookBlock(RUNBOOK_CASES.find(test => test.id === 'weekly-triage'), {}), null)
})

it('requires separate successful Google and Bing inspection results', () => {
  const definition = RUNBOOK_CASES.find(test => test.id === 'google-and-bing')
  const calls = [
    { args: ['inspect', 'https://example.com/a', '--json'], code: 0, stdout: '{"site":"sc-domain:example.com","inspected":1,"results":[{"url":"https://example.com/a","status":"inspected"}]}' },
    { args: ['bing', 'inspect', 'https://example.com/a', '--json'], code: 0, stdout: '{"url":"https://example.com/a","searchEngine":"bing","observedAt":"2026-08-08"}' },
  ]
  assert.equal(gradeRunbook({ definition, calls, loaded: true, text: 'Google and Bing observed the URL separately.', expected: { url: 'https://example.com/a' } }).passed, true)
  assert.equal(gradeRunbook({ definition, calls: [{ ...calls[0], code: 1 }, calls[1]], loaded: true, text: 'Bing observed the URL.' }).passed, false)
  assert.equal(gradeRunbook({ definition, calls, loaded: false, text: 'Both observed the URL.' }).passed, false)
})
