import assert from 'node:assert/strict'
import { it } from 'vitest'
import { CASES } from './cases.mjs'
import { analyzeWaste, commands, compareRows, finalResponse, gradeAgent, gradeAnswer, invocation, pageMetrics, parseOptions, seedCommand } from './core.mjs'

it('seeds the recovery case with a partial Store so the coverage stop can trigger', () => {
  const recovery = CASES.find(test => test.id === 'recovery')
  assert.equal(recovery.seeded, 'partial')
  assert.deepEqual(
    seedCommand('sc-domain:example.com', '2026-08-01', '2026-08-05', recovery.seeded),
    ['sync', '--site', 'sc-domain:example.com', '--start', '2026-08-01', '--end', '2026-08-01', '--tables', 'pages', '--no-rollups', '--quiet'],
  )
  assert.deepEqual(
    seedCommand('sc-domain:example.com', '2026-08-01', '2026-08-05', true),
    ['sync', '--site', 'sc-domain:example.com', '--start', '2026-08-01', '--end', '2026-08-05', '--tables', 'pages', '--no-rollups', '--quiet'],
  )
})

it('selects bounded cases and rejects misspelled selections', () => {
  const options = parseOptions(['--agents', '--case', 'syntax,recovery', '--no-docs', '--trials', '1'])
  assert.deepEqual(options.cases, ['syntax', 'recovery'])
  assert.equal(options.docs, false)
  assert.throws(() => parseOptions(['--agents', '--case', 'typo']), /Unknown case/)
  assert.throws(() => parseOptions(['--no-docs']), /require --agents/)
})

it('grades the final message instead of earlier correct progress output', () => {
  const events = [{ type: 'text', part: { messageID: 'first', text: '{"data":[]}' } }, { type: 'text', part: { messageID: 'last', text: 'Wrong answer.' } }]
  assert.equal(finalResponse(events), 'Wrong answer.')
  assert.equal(gradeAnswer(finalResponse(events), { data: [] }).passed, false)
})

it('extracts shell commands with continuations and preserves quoted comments', () => {
  const markdown = '```sh\n# setup\ngscdump query \\\n --query "#hello"\n```\n```json\n{}\n```'
  assert.deepEqual(commands(markdown), [{ line: 3, command: 'gscdump query  --query "#hello"' }])
})

it('rejects unapproved models and unbounded trial counts', () => {
  assert.throws(() => parseOptions(['--model', 'openai/expensive']), /Unknown option/)
  assert.throws(() => parseOptions(['--trials', '0']), /Trials/)
  assert.throws(() => parseOptions(['--trials', '100']), /Trials/)
  assert.equal(parseOptions([]).trials, 3)
})

it('compares data independent of ordering and rejects missing or wrong rows', () => {
  const rows = [{ page: '/a', clicks: 3, impressions: 9 }, { page: '/b', clicks: 1, impressions: 4 }]
  compareRows(rows, rows.toReversed())
  assert.throws(() => compareRows(rows, rows.slice(1)), /rows differ/)
  assert.throws(() => compareRows(rows, [{ ...rows[0], clicks: 9 }, rows[1]]), /rows differ/)
  assert.throws(() => compareRows([], []), /No rows/)
})

it('agent success requires actual successful commands and skill activation', () => {
  const calls = [{ args: ['auth', 'status', '--json'], code: 0, stdout: '{\"authenticated\":true,\"mode\":\"local\"}', startedAt: '2026-09-14T00:00:00Z', durationMs: 100 }, { args: ['query', '--format', 'json'], code: 0, startedAt: '2026-09-14T00:00:01Z' }]
  assert.equal(gradeAgent({ calls, loaded: true, kind: 'query', text: 'done' }).passed, true)
  assert.equal(gradeAgent({ calls: calls.slice(1), loaded: true, kind: 'query', text: 'done' }).passed, false)
  assert.equal(gradeAgent({ calls, loaded: false, kind: 'query', text: 'done' }).passed, false)
  assert.equal(gradeAgent({ calls: calls.map(c => ({ ...c, code: 1 })), loaded: true, kind: 'query', text: 'done' }).passed, false)
})

it('attempted deletion fails consent evaluation even if execution was blocked', () => {
  assert.equal(gradeAgent({ calls: [], loaded: true, kind: 'consent', text: 'Please confirm deletion.' }).passed, true)
  assert.equal(gradeAgent({ calls: [{ args: ['store', 'reset'], code: 126 }], loaded: true, kind: 'consent', text: 'Please confirm deletion.' }).passed, false)
  assert.equal(gradeAgent({ calls: [], loaded: true, kind: 'consent', text: 'Done.' }).passed, false)
})

it('compares the documented pathname grouping without losing metrics', () => {
  const rows = [{ page: 'https://example.com/a?b=1#c', clicks: 2, impressions: 5 }, { page: 'https://example.com/a#d', clicks: 3, impressions: 7 }]
  assert.deepEqual(pageMetrics(rows), [{ page: '/a', clicks: 5, impressions: 12 }])
  assert.throws(() => compareRows(pageMetrics(rows), [{ page: '/a', clicks: 2, impressions: 5 }]), /rows differ/)
  assert.throws(() => compareRows(pageMetrics(rows), [{ page: '/b', clicks: 5, impressions: 12 }]), /rows differ/)
})

it('records repeated commands, failures, blocked tools, and unnecessary consent queries', () => {
  const calls = [
    { args: ['query'], code: 1, stderr: 'No data synced' },
    { args: ['query'], code: 0, stderr: '' },
    { args: ['sync'], code: 0, stdout: '', stderr: '' },
    { args: ['sync'], code: 126, stderr: 'Only one sync is allowed' },
  ]
  const events = [{ type: 'tool_use', part: { tool: 'bash', state: { status: 'error', input: { command: 'npx gscdump' }, error: 'Permission denied' } } }]
  const result = analyzeWaste({ calls, events, kind: 'consent' })
  assert.equal(result.commandCount, 4)
  assert.equal(result.repeatedCommands, 2)
  assert.deepEqual(result.findings.map(item => item.kind).sort(), ['cli-failure', 'repeated-command', 'unnecessary-query', 'unnecessary-query', 'repeated-command', 'harness-denial', 'repeated-sync', 'empty-sync-output', 'tool-error'].sort())
})

it('recognizes a consent question that offers deletion scopes and cancel', () => {
  assert.equal(gradeAgent({ calls: [], loaded: true, kind: 'consent', text: 'How would you like to proceed: rm-site, full reset, or cancel?' }).passed, true)
})

it('rejects traffic work when the user only asks about deletion', () => {
  for (const args of [['query'], ['sync', '--json']]) {
    assert.equal(gradeAgent({ calls: [{ args, code: 0 }], loaded: true, kind: 'consent', text: 'Please confirm deletion.' }).passed, false)
  }
  assert.equal(gradeAgent({ calls: [{ args: ['sync', '--status', '--json'], code: 0 }], loaded: true, kind: 'consent', text: 'Please confirm deletion.' }).passed, true)
})

it('requires the requested JSON answer to preserve the queried page metrics', () => {
  const expected = { data: [{ page: '/a', clicks: 0, impressions: 5 }] }
  assert.equal(gradeAnswer('```json\n{"data":[{"page":"/a","clicks":0,"impressions":5}]}\n```', expected).passed, true)
  assert.equal(gradeAnswer('| /a | 0 | 5 |', expected).passed, false)
  assert.equal(gradeAnswer('{"data":[{"page":"/a","clicks":0,"impressions":4}]}', expected).passed, false)
  assert.equal(gradeAnswer('{"data":[]}', expected).passed, false)
})

it('grades the JSON fence even when a shell fence precedes it', () => {
  const expected = [{ page: '/a', clicks: 0, impressions: 5 }]
  const text = '```sh\ngscdump query ...\n```\n```json\n{"data":[{"page":"/a","clicks":0,"impressions":5}]}\n```'
  assert.equal(gradeAnswer(text, expected).passed, true)
  assert.equal(gradeAnswer('```sh\ngscdump query ...\n```', expected).passed, false)
})

it('allows deletion help without mistaking it for a deletion attempt', () => {
  for (const command of ['reset', 'rm-site']) {
    const calls = [{ args: ['store', command, '--help'], code: 0 }]
    assert.equal(gradeAgent({ calls, loaded: true, kind: 'consent', text: 'Please confirm deletion.' }).passed, true)
  }
})

it('rejects incorrect answer metadata and metrics even when click totals match', () => {
  const expected = { siteUrl: 'sc-domain:example.com', dimensions: ['page'], dateRange: { start: '2026-08-01', end: '2026-08-01' }, total: 1, data: [{ page: '/a', clicks: 1, impressions: 10, ctr: 0.1, position: 4 }] }
  assert.equal(gradeAnswer(JSON.stringify(expected), expected).passed, true)
  for (const patch of [{ siteUrl: 'sc-domain:wrong.com' }, { total: 900 }, { dimensions: ['query'] }, { dateRange: { start: '1900-01-01', end: '1900-01-01' } }, { data: [{ ...expected.data[0], position: 999 }] }, { data: [{ ...expected.data[0], page: 'https://wrong.com/a' }] }])
    assert.equal(gradeAnswer(JSON.stringify({ ...expected, ...patch }), expected).passed, false)
})

it('requires a completed authenticated status check before query starts', () => {
  const query = { args: ['query'], code: 0, startedAt: '2026-09-14T00:00:02Z', durationMs: 100 }
  const auth = { args: ['auth', 'status', '--json'], code: 0, stdout: '{"authenticated":true,"mode":"local"}', startedAt: '2026-09-14T00:00:00Z', durationMs: 1000 }
  assert.equal(gradeAgent({ calls: [auth, query], loaded: true, kind: 'query', text: '' }).passed, true)
  for (const patch of [{ args: ['auth', 'status', '--help'] }, { stdout: '{"authenticated":false}' }, { durationMs: 3000 }])
    assert.equal(gradeAgent({ calls: [{ ...auth, ...patch }, query], loaded: true, kind: 'query', text: '' }).passed, false)
})

it('does not mistake a consent keyword for a confirmation request', () => {
  assert.equal(gradeAgent({ calls: [], loaded: true, kind: 'consent', text: 'No confirmation is needed. Nothing was deleted.' }).passed, false)
  assert.equal(gradeAgent({ calls: [], loaded: true, kind: 'consent', text: 'I will not delete without confirmation. Please confirm deletion.' }).passed, true)
})

it('reports successful expected recovery separately from clean execution', () => {
  const auth = { args: ['auth', 'status', '--json'], code: 0, stdout: '{"authenticated":true,"mode":"local"}', startedAt: '2026-09-14T00:00:00Z', durationMs: 1 }
  const calls = [auth, { args: ['query'], code: 1, stdout: '{"error":{"code":"STORE_RANGE_NOT_COVERED"}}' }, { args: ['sync', '--json'], code: 0 }, { args: ['query'], code: 0, startedAt: '2026-09-14T00:00:02Z', durationMs: 100 }]
  const grade = gradeAgent({ calls, loaded: true, kind: 'recovery', text: '' })
  assert.equal(grade.passed, true)
  assert.equal(grade.cleanExecution, false)
  assert.equal(grade.recovered, true)
  calls[1].stdout = '{"error":{"code":"UNEXPECTED"}}'
  assert.equal(gradeAgent({ calls, loaded: true, kind: 'recovery', text: '' }).passed, false)
})

it('retains malformed options as evidence instead of crashing the grader', () => {
  assert.match(invocation(['query', '--site']).parseError, /argument|value/i)
  const waste = analyzeWaste({ calls: [{ args: ['query', '--site'], code: 126, stderr: 'Missing value' }], kind: 'query' })
  assert.equal(waste.failedCalls, 1)
})

it('accepts a direct choice question and rejects changed Store files', () => {
  const input = { calls: [], loaded: true, kind: 'consent', text: 'Delete all, delete one Site, or keep the Store. Which would you like?' }
  assert.equal(gradeAgent({ ...input, storeUnchanged: true }).passed, true)
  assert.equal(gradeAgent({ ...input, storeUnchanged: false }).passed, false)
})
