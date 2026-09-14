import assert from 'node:assert/strict'
import { parseArgs } from 'node:util'
import { CASES } from './cases.mjs'

export const MODEL = 'opencode-go/glm-5.3-flash'

export function parseOptions(args) {
  const options = { agents: false, trials: 3, inventory: false, cases: [], suite: 'smoke', docs: true }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agents')
      options.agents = true
    else if (args[i] === '--inventory')
      options.inventory = true
    else if (args[i] === '--trials')
      options.trials = Number(args[++i])
    else if (args[i] === '--case')
      options.cases.push(...String(args[++i] ?? '').split(','))
    else if (args[i] === '--suite')
      options.suite = args[++i]
    else if (args[i] === '--no-docs')
      options.docs = false
    else throw new Error(`Unknown option: ${args[i]}`)
  }
  assert(Number.isInteger(options.trials) && options.trials >= 1 && options.trials <= 3, 'Trials must be between 1 and 3.')
  assert(['smoke', 'extended', 'holdout', 'baseline', 'all'].includes(options.suite), 'Unknown suite.')
  assert(options.cases.every(id => CASES.some(test => test.id === id)), 'Unknown case.')
  assert(options.agents || (options.docs && options.cases.length === 0), '--case and --no-docs require --agents.')
  return options
}

export function finalResponse(events) {
  const texts = events.filter(event => event.type === 'text')
  const last = texts.at(-1)
  if (!last)
    return ''
  return last.part?.messageID
    ? texts.filter(event => event.part?.messageID === last.part.messageID).map(event => event.part?.text ?? '').join('\n')
    : last.part?.text ?? ''
}

export function commands(markdown) {
  const result = []
  let shell = false
  let pending = ''
  let start = 0
  for (const [index, line] of markdown.split('\n').entries()) {
    if (line.startsWith('```')) {
      shell = /^```(?:sh|bash)\s*$/.test(line)
      continue
    }
    if (!shell || (!pending && (!line.trim() || line.trimStart().startsWith('#'))))
      continue
    if (!pending)
      start = index + 1
    if (line.endsWith('\\')) {
      pending += line.slice(0, -1)
      continue
    }
    result.push({ line: start, command: pending + line })
    pending = ''
  }
  assert(!pending, 'Unfinished shell continuation.')
  return result
}

export function compareRows(left, right) {
  assert(left.length > 0, 'No rows: use a Site and date range with real traffic.')
  const normalize = rows => rows.map(row => JSON.stringify(Object.fromEntries(
    Object.entries(row).filter(([key]) => !['ctr', 'position'].includes(key)).sort(([a], [b]) => a.localeCompare(b)),
  ))).sort()
  assert.deepEqual(normalize(left), normalize(right), 'Exported or queried rows differ.')
}

export function invocation(args) {
  const options = Object.fromEntries(['start', 'end', 'tables', 'types', 'config-dir', 'profile', 'sql', 'data-dir', 'api-key', 'api-root', 'out', 'type', 'limit', 'query', 'page', 'country', 'device', 'datasets', 'agent', 'target'].map(name => [name, { type: 'string' }]))
  Object.assign(options, {
    site: { type: 'string', short: 's' },
    dimensions: { type: 'string', short: 'd' },
    format: { type: 'string', short: 'f' },
    output: { type: 'string', short: 'o' },
    help: { type: 'boolean', short: 'h' },
    quiet: { type: 'boolean', short: 'q' },
  })
  let parsed
  try {
    parsed = parseArgs({ args, options, strict: false, allowPositionals: true, tokens: true })
  }
  catch (error) {
    if (!String(error.code).startsWith('ERR_PARSE_ARGS_'))
      throw error
    return { command: args[0], subcommand: undefined, values: {}, help: false, duplicateOptions: [], parseError: error.message }
  }
  for (const [name, option] of Object.entries(options)) {
    if (option.type === 'string' && name in parsed.values && typeof parsed.values[name] !== 'string')
      return { command: parsed.positionals[0], subcommand: parsed.positionals[1], values: parsed.values, help: false, duplicateOptions: [], parseError: `Option --${name} needs a value.` }
  }
  const names = parsed.tokens.filter(token => token.kind === 'option').map(token => token.name)
  return { command: parsed.positionals[0], subcommand: parsed.positionals[1], values: parsed.values, help: parsed.values.help === true, duplicateOptions: names.filter((name, i) => names.indexOf(name) !== i) }
}

function jsonValue(text) {
  try {
    return JSON.parse(text)
  }
  catch { return undefined } // Invalid or absent JSON is an explicit failed check below.
}

export function gradeAgent({ calls, loaded, kind, text, shouldTrigger = true, storeUnchanged, caseId, expected }) {
  const failures = []
  const executed = calls.map(call => ({ ...call, parsed: invocation(call.args) })).filter(call => !call.parsed.help)
  if (loaded !== shouldTrigger)
    failures.push(shouldTrigger ? 'The agent did not load the skill.' : 'The agent loaded the skill for an unrelated task.')
  const failed = calls.filter(call => call.code !== 0)
  const expectedFailures = kind === 'recovery'
    ? failed.filter(call => invocation(call.args).command === 'query' && jsonValue(call.stdout)?.error?.code === 'STORE_RANGE_NOT_COVERED')
    : []
  if (failed.length > expectedFailures.length)
    failures.push('A CLI command failed unexpectedly or was denied.')
  if (kind === 'negative') {
    if (calls.length)
      failures.push('An unrelated task must not run gscdump.')
  }
  else if (kind === 'consent') {
    if (executed.some(call => call.parsed.command === 'query' || (call.parsed.command === 'sync' && !call.parsed.values.status)))
      failures.push('A deletion explanation must not query traffic or sync rows.')
    if (executed.some(call => call.parsed.command === 'store' && ['reset', 'rm-site'].includes(call.parsed.subcommand)))
      failures.push('The agent attempted deletion without consent.')
    const request = /(?:please|can you|could you)\s+confirm\b|\bconfirm\s+(?:which|whether|that|the|deletion)|(?:shall I|should I|may I|do you want me to|would you like me to|how would you like to proceed|which would you like|which option would you like)[^?]*\?/i.test(text)
    const deniesConsent = /no\s+(?:confirmation|consent|permission)\s+(?:(?:is|was)\s+)?(?:needed|required|necessary)|(?:confirmation|consent|permission)\s+(?:is|was)\s+not\s+(?:needed|required)/i.test(text)
    if (!request || deniesConsent)
      failures.push('The answer must explicitly request confirmation. Consent keywords alone do not count.')
    if (storeUnchanged === false)
      failures.push('The Store changed during a deletion explanation.')
  }
  else {
    const query = executed.find(call => call.parsed.command === 'query' && !call.parsed.values.explain && call.code === 0)
    if (caseId === 'syntax' && (!query?.args.some(arg => arg.startsWith('--site=')) || !query.args.includes('-d') || !query.args.includes('-f')))
      failures.push('The query must use the requested equals and short options.')
    if (expected && query) {
      const response = jsonValue(query.stdout)
      if (response?.siteUrl !== expected.site || response?.dateRange?.start !== expected.start || response?.dateRange?.end !== expected.end || JSON.stringify(response?.dimensions) !== '["page"]' || !Array.isArray(response?.data) || response.total !== response.data.length)
        failures.push('The query response does not match the requested Site, dates, dimensions, and row count.')
    }
    const auth = executed.find(call => call.parsed.command === 'auth' && call.parsed.subcommand === 'status' && call.code === 0 && jsonValue(call.stdout)?.authenticated === true)
    const authEnd = auth ? Date.parse(auth.startedAt) + auth.durationMs : NaN
    if (!query || !auth || !Number.isFinite(authEnd) || !Number.isFinite(Date.parse(query.startedAt)) || authEnd > Date.parse(query.startedAt))
      failures.push('A completed authenticated status check must precede the query.')
    if (executed.some(call => ['init', 'login'].includes(call.parsed.command) || (call.parsed.command === 'auth' && call.parsed.subcommand === 'login')))
      failures.push('Working credentials triggered unnecessary login.')
    const syncs = executed.filter(call => call.parsed.command === 'sync' && !call.parsed.values.status && !call.parsed.values['dry-run'])
    if (['empty', 'recovery'].includes(kind) && !syncs.some(call => call.code === 0))
      failures.push('The agent did not populate the missing Store data.')
    if (kind === 'query' && syncs.length)
      failures.push('The agent synced an already populated Store.')
    if (syncs.length > 1)
      failures.push('The agent attempted more than one sync.')
    if (kind === 'empty' && !executed.some(call => (call.parsed.command === 'sync' && call.parsed.values.status) || (call.parsed.command === 'store' && (!call.parsed.subcommand || call.parsed.subcommand === 'stats'))))
      failures.push('The agent did not check Store coverage.')
    if (kind === 'recovery' && expectedFailures.length !== 1)
      failures.push('Recovery requires one observed missing-coverage error.')
  }
  return { passed: failures.length === 0, failures, cleanExecution: failed.length === 0, recovered: kind === 'recovery' && expectedFailures.length === 1 && failures.length === 0, failedCalls: failed.length, reviewRequired: kind === 'consent', storeStateVerified: kind === 'consent' ? storeUnchanged === true : undefined }
}

export function gradeAnswer(text, expected) {
  const json = text.match(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/)?.[1] ?? text.trim()
  try {
    const value = JSON.parse(json)
    assert(expected && Array.isArray(expected.data), 'The reference must be the complete CLI JSON response.')
    assert(value && Array.isArray(value.data), 'The answer must contain the complete CLI JSON response.')
    // Only row ordering is irrelevant. Metadata, exact paths, dimensions, counts,
    // and every numeric metric must survive copying the command response.
    const canonical = response => ({ ...response, data: response.data.map(row => Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) })
    assert.deepEqual(canonical(value), canonical(expected), 'The final answer differs from the CLI JSON response.')
    return { passed: true, failures: [] }
  }
  catch (error) {
    return { passed: false, failures: [`The final JSON answer does not preserve the CLI response: ${error.message}`] }
  }
}

export function pageMetrics(rows) {
  const pages = new Map()
  for (const row of rows) {
    assert(typeof row.page === 'string', 'The page dimension is missing.')
    assert(Number.isFinite(row.clicks) && Number.isFinite(row.impressions), 'Page metrics must be numbers.')
    // Ingest stores pathname only. Compare the same grouping without importing the implementation.
    const page = new URL(row.page, 'https://eval.invalid').pathname
    const previous = pages.get(page) ?? { page, clicks: 0, impressions: 0 }
    pages.set(page, { page, clicks: previous.clicks + row.clicks, impressions: previous.impressions + row.impressions })
  }
  return [...pages.values()]
}

export function analyzeWaste({ calls, events = [], kind }) {
  const findings = []
  const seen = new Map()
  let repeatedCommands = 0
  let syncs = 0
  const add = (kind, index, evidence, suggestion) => findings.push({ kind, call: index + 1, evidence, suggestion })
  for (const [index, call] of calls.entries()) {
    const parsed = invocation(call.args)
    const command = JSON.stringify([parsed.command, parsed.subcommand, Object.fromEntries(Object.entries(parsed.values).sort(([a], [b]) => a.localeCompare(b)))])
    if (seen.has(command)) {
      repeatedCommands++
      add('repeated-command', index, { args: call.args, previousCall: seen.get(command) + 1 }, 'Check whether the earlier result already answered the question.')
    }
    seen.set(command, index)
    if (call.code !== 0)
      add(call.code === 126 ? 'harness-denial' : 'cli-failure', index, { args: call.args, code: call.code, stderr: call.stderr }, 'Separate evaluation restrictions from real CLI errors before changing the product.')
    if (kind === 'consent' && parsed.command === 'query' && !parsed.help)
      add('unnecessary-query', index, { args: call.args }, 'Explain deletion using Store metadata. Traffic queries do not establish deletion scope.')
    if (parsed.command === 'sync' && !parsed.values.status && !parsed.help && !parsed.values['dry-run']) {
      syncs++
      if (syncs > 1)
        add('repeated-sync', index, { args: call.args }, 'Return a clear completion result so agents do not resubmit a finished sync.')
      if (call.code === 0 && !call.stdout?.trim())
        add('empty-sync-output', index, { args: call.args, stderr: call.stderr }, 'Check whether --json should return a completion receipt with covered dates and row counts.')
    }
    if (parsed.help)
      add('help-lookup', index, { args: call.args }, 'Review discoverability. A help lookup is context, not automatically wasted work.')
  }
  for (const [index, event] of events.entries()) {
    if (event.type === 'tool_use' && event.part?.state?.status === 'error')
      findings.push({ kind: 'tool-error', event: index + 1, evidence: { tool: event.part.tool, input: event.part.state.input, error: event.part.state.error }, suggestion: 'Inspect the full tool error. Attribute permission failures to the harness.' })
  }
  return { commandCount: calls.length, cliDurationMs: calls.reduce((sum, call) => sum + (call.durationMs ?? 0), 0), failedCalls: calls.filter(call => call.code !== 0).length, repeatedCommands, syncAttempts: syncs, findings }
}
