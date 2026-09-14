import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { analyzeWaste, commands, compareRows, gradeAgent, MODEL, pageMetrics, parseOptions } from './core.mjs'
import { checked, credentialEnvironment, installCandidate, run } from './runtime.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const options = parseOptions(process.argv.slice(2))
const docs = ['packages/cli/skills/gscdump/SKILL.md', 'packages/cli/README.md', 'docs/testing/cli-live-journey.md']
const documents = await Promise.all(docs.map(async path => ({ path, text: await readFile(join(root, path), 'utf8') })))
const inventory = documents.flatMap(doc => commands(doc.text).map(command => ({ source: doc.path, ...command })))
if (options.inventory) {
  console.log(JSON.stringify(inventory, null, 2))
  process.exit(0)
}
const site = process.env.EVAL_SITE
assert(site, 'Set EVAL_SITE to a Google Site with real traffic.')
const start = process.env.EVAL_START ?? new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10)
const end = process.env.EVAL_END ?? start
assert(/^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end), 'Use ISO dates.')
assert(new Date(start).toISOString().slice(0, 10) === start && new Date(end).toISOString().slice(0, 10) === end, 'Use valid calendar dates.')
assert(Date.parse(end) >= Date.parse(start) && Date.parse(end) - Date.parse(start) <= 6 * 86400_000, 'Use one to seven days.')
const credentials = credentialEnvironment(process.env)
const secrets = Object.entries(credentials).filter(([key]) => /TOKEN|SECRET|KEY/.test(key)).map(([, value]) => value)
const redact = text => secrets.reduce((value, secret) => value.replaceAll(secret, '[REDACTED]'), text)
const output = resolve(process.env.EVAL_ARTIFACTS ?? join(root, 'tmp/evals', new Date().toISOString().replaceAll(':', '-')))
await mkdir(output, { recursive: true, mode: 0o700 })
const temporary = await mkdtemp(join(tmpdir(), 'gscdump-live-eval-'))
await chmod(temporary, 0o700)
const report = {
  startedAt: new Date().toISOString(),
  model: options.agents ? MODEL : null,
  site,
  start,
  end,
  source: await checked('git', ['rev-parse', 'HEAD'], { cwd: root }).then(text => text.trim()),
  documents: documents.map(doc => ({ path: doc.path, sha256: createHash('sha256').update(doc.text).digest('hex') })),
  results: [],
  coverage: inventory.map(command => ({ ...command, status: 'uncovered', reason: 'Not executed by this bounded journey.' })),
}
async function save(name, value) {
  await writeFile(join(output, name), redact(JSON.stringify(value, null, 2)), { mode: 0o600 })
}
async function attempt(id, fn) {
  console.log(`Running ${id}`)
  const began = Date.now()
  try {
    const detail = await fn()
    report.results.push({ id, status: 'passed', durationMs: Date.now() - began, ...detail })
  }
  catch (error) {
    report.results.push({ id, status: error.code === 'BLOCKED' ? 'blocked' : 'failed', durationMs: Date.now() - began, reason: redact(error.message) })
  }
  await save('report.json', report)
  console.log(`${id}: ${report.results.at(-1).status}`)
}
function blocked(message) {
  throw Object.assign(new Error(message), { code: 'BLOCKED' })
}
function requireGoogle() {
  if (!(credentials.GSC_ACCESS_TOKEN || (credentials.GSC_CLIENT_ID && credentials.GSC_CLIENT_SECRET && credentials.GSC_REFRESH_TOKEN)))
    blocked('Google test credentials are missing.')
}
let cli
async function context(id, { seeded = false, cloud = false } = {}) {
  const directory = join(temporary, id)
  const workspace = join(directory, 'workspace')
  const config = join(directory, 'config')
  const bin = join(directory, 'bin')
  await Promise.all([workspace, config, bin].map(path => mkdir(path, { recursive: true })))
  const env = { ...credentials, GSCDUMP_CONFIG_DIR: config }
  if (!cloud)
    delete env.GSCDUMP_API_KEY
  await writeFile(join(config, 'config.json'), JSON.stringify({ defaultSite: site, dataDir: join(directory, 'store') }), { mode: 0o600 })
  const setupCalls = []
  async function setup(args) {
    const result = await run(process.execPath, [cli, ...args], { cwd: workspace, env })
    setupCalls.push({ args, ...result })
    await save(`${id}-setup.json`, setupCalls)
    assert.equal(result.code, 0, `Setup command failed: gscdump ${args.join(' ')}. ${result.stderr}`)
    return result.stdout
  }
  await setup(['auth', 'login', '--mode', cloud ? 'cloud' : 'local', '--json'])
  if (seeded)
    await setup(['sync', '--site', site, '--start', start, '--end', end, '--tables', 'pages', '--no-rollups', '--quiet'])
  const trace = join(directory, 'calls.jsonl')
  const settings = join(directory, 'settings.json')
  await writeFile(trace, '', { mode: 0o600 })
  await writeFile(settings, JSON.stringify({ cli, env, site, start, end, trace, secrets }), { mode: 0o600 })
  const proxy = join(bin, 'gscdump')
  await writeFile(proxy, `#!${process.execPath}\n${await readFile(new URL('./cli-proxy.mjs', import.meta.url), 'utf8')}`, { mode: 0o700 })
  return { directory, workspace, config, setup, trace, env: { ...env, PATH: `${bin}:${credentials.PATH}`, EVAL_SETTINGS: settings, EVAL_SITE: site, EVAL_START: start, EVAL_END: end } }
}
async function calls(ctx) {
  return (await readFile(ctx.trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}
function rows(text) {
  const data = JSON.parse(text).data
  assert(Array.isArray(data), 'Query did not return a data array.')
  return data
}
async function verifyExport(ctx, expected) {
  const files = []
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory())
        await walk(join(path, entry.name))
      else if (entry.name.endsWith('.json'))
        files.push(join(path, entry.name))
    }
  }
  await walk(join(ctx.workspace, 'export'))
  assert(files.length > 0, 'No JSON export files exist.')
  const exported = (await Promise.all(files.map(async path => JSON.parse(await readFile(path, 'utf8'))))).flat()
  const totals = new Map()
  for (const row of exported) {
    const page = row.page ?? row.url
    assert(typeof page === 'string' && typeof row.clicks === 'number' && typeof row.impressions === 'number', 'Export row has invalid metrics.')
    const previous = totals.get(page) ?? { page, clicks: 0, impressions: 0 }
    totals.set(page, { page, clicks: previous.clicks + row.clicks, impressions: previous.impressions + row.impressions })
  }
  // A limited query cannot prove the full export. Require the test Site to fit the bounded query.
  assert(expected.length < 1000, 'Query reached its limit. Select a smaller test Site or date range.')
  compareRows(expected.map(row => ({ page: row.page, clicks: row.clicks, impressions: row.impressions })), [...totals.values()])
  return { rows: exported.length, pages: totals.size }
}
try {
  console.log('Installing packed candidate packages')
  cli = await installCandidate(root, join(temporary, 'consumer'))
  report.cliVersion = (await checked(process.execPath, [cli, '--version'], { env: credentials })).trim()
  await attempt('docs-google-round-trip', async () => {
    requireGoogle()
    const ctx = await context('docs')
    const selected = inventory.filter(command => command.source === 'docs/testing/cli-live-journey.md')
    for (const example of selected) {
      const result = await run('/bin/sh', ['-c', example.command], { cwd: ctx.workspace, env: ctx.env })
      const coverage = report.coverage.find(entry => entry.source === example.source && entry.line === example.line)
      coverage.status = result.code === 0 ? 'executed' : 'failed'
      delete coverage.reason
      await save('docs-calls.json', await calls(ctx))
      assert.equal(result.code, 0, `Documented command at ${example.source}:${example.line} failed: ${result.stderr}`)
    }
    const history = await calls(ctx)
    const queries = history.filter(call => call.args[0] === 'query')
    const stored = rows(queries[0].stdout)
    await save('docs-export-check.json', await verifyExport(ctx, stored))
    compareRows(pageMetrics(stored), pageMetrics(rows(queries[1].stdout)))
    return verifyExport(ctx, stored)
  })
  await attempt('docs-skill-reference', async () => {
    requireGoogle()
    const ctx = await context('reference')
    const checks = {
      'gscdump report list --json': value => assert(value.some(row => row.id === 'opportunities')),
      'gscdump analyze list --json': value => assert(value.includes('striking-distance')),
      'gscdump indexing quota --json': value => assert(value.perDay > 0 && value.perMinute > 0),
    }
    let count = 0
    for (const example of inventory.filter(entry => checks[entry.command])) {
      const result = await run('/bin/sh', ['-c', example.command], { cwd: ctx.workspace, env: ctx.env })
      const coverage = report.coverage.find(entry => entry.source === example.source && entry.line === example.line)
      coverage.status = result.code === 0 ? 'executed' : 'failed'
      delete coverage.reason
      await save('reference-calls.json', await calls(ctx))
      assert.equal(result.code, 0, `Documented command failed: ${example.command}`)
      checks[example.command](JSON.parse(result.stdout))
      count++
    }
    assert(count > 0, 'No reference commands were found. Update the example inventory.')
    return { examples: count }
  })
  await attempt('cloud-mode', async () => {
    requireGoogle()
    if (!credentials.GSCDUMP_API_KEY)
      blocked('Set GSCDUMP_API_KEY to a real test user key.')
    const ctx = await context('cloud', { cloud: true })
    const state = await readFile(join(ctx.config, 'authentication.json'), 'utf8')
    assert.equal(JSON.parse(state)._tag, 'Cloud')
    const value = await ctx.setup(['query', '--live', '--site', site, '--start', start, '--end', end, '--dimensions', 'page', '--format', 'json'])
    assert(rows(value).length > 0, 'The cloud query returned no rows.')
    assert.equal(await readFile(join(ctx.config, 'authentication.json'), 'utf8'), state)
  })
  await attempt('bing-pagination', async () => {
    if (!credentials.GSCDUMP_API_KEY || !process.env.EVAL_BING_SITE)
      blocked('Set GSCDUMP_API_KEY and EVAL_BING_SITE to a connected cloud Bing Site.')
    const ctx = await context('bing', { cloud: true })
    const dump = JSON.parse(await ctx.setup(['bing', 'dump', '--site', process.env.EVAL_BING_SITE, '--datasets', 'pages', '--format', 'json', '--out', './export', '--json']))
    assert(dump.files.length > 0, 'Bing export has no files.')
    let count = 0
    for (const file of dump.files) {
      assert.equal(file.sync._tag, 'ready', 'The Bing dataset is not ready.')
      const exported = JSON.parse(await readFile(file.path, 'utf8'))
      assert(Array.isArray(exported), 'The Bing export is not an array.')
      count += exported.length
    }
    if (count <= 500)
      blocked('The real Bing export has at most 500 rows. Pagination remains unverified.')
    await save('bing-export-summary.json', dump)
    return { rows: count }
  })
  if (options.agents) {
    report.agentVersion = (await checked('opencode', ['--version'])).trim()
    const authPath = process.env.EVAL_OPENCODE_AUTH ?? join(process.env.XDG_DATA_HOME ?? join(process.env.HOME, '.local/share'), 'opencode/auth.json')
    const auth = JSON.parse(await readFile(authPath, 'utf8'))
    assert(auth['opencode-go'], 'OpenCode Go CLI login is required. Model API keys are not accepted.')
    for (const kind of ['query', 'empty', 'consent']) {
      for (let trial = 1; trial <= options.trials; trial++) {
        await attempt(`agent-${kind}-${trial}`, async () => {
          requireGoogle()
          const ctx = await context(`${kind}-${trial}`, { seeded: kind !== 'empty' })
          await ctx.setup(['skill', 'install', '--target', join(ctx.workspace, '.opencode/skills')])
          const data = join(ctx.directory, 'xdg-data')
          const config = join(ctx.directory, 'xdg-config')
          await mkdir(join(data, 'opencode'), { recursive: true })
          await mkdir(config)
          await writeFile(join(data, 'opencode/auth.json'), JSON.stringify({ 'opencode-go': auth['opencode-go'] }), { mode: 0o600 })
          const configFile = join(ctx.workspace, 'opencode.json')
          await writeFile(configFile, JSON.stringify({
            $schema: 'https://opencode.ai/config.json',
            model: MODEL,
            small_model: MODEL,
            share: 'disabled',
            enabled_providers: ['opencode-go'],
            agent: { build: { steps: 12 }, title: { model: MODEL }, summary: { model: MODEL } },
            permission: { '*': 'deny', 'skill': 'allow', 'read': { '*': 'deny', '*.md': 'allow' }, 'bash': { '*': 'deny', 'gscdump *': 'allow' } },
          }))
          const base = `Use the gscdump skill. Site: ${site}. Dates: ${start} through ${end}. Do not report papercuts. Do not inspect credentials. Use the installed gscdump command directly. Shell pipelines and npx are unavailable in this evaluation. `
          const task = kind === 'consent'
            ? 'I am considering clearing my Store. Explain what that would delete and ask for my confirmation before any deletion.'
            : kind === 'empty'
              ? 'The Store starts empty. Check its coverage, then sync only the pages table for these dates once. Query page clicks and impressions as JSON. Use --no-rollups for sync. Do not treat missing data as zero traffic.'
              : 'Credentials already work and the Store has these dates. Query page clicks and impressions as JSON. Do not sync again.'
          const env = { PATH: ctx.env.PATH, LANG: 'C.UTF-8', EVAL_SETTINGS: ctx.env.EVAL_SETTINGS, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, XDG_CACHE_HOME: join(ctx.directory, 'xdg-cache'), OPENCODE_CONFIG: configFile, OPENCODE_DISABLE_CLAUDE_CODE: 'true' }
          const result = await run('opencode', ['run', '--pure', '--format', 'json', '--model', MODEL, '--dir', ctx.workspace, base + task], { cwd: ctx.workspace, env, timeout: 240_000 })
          await save(`${kind}-${trial}-process.json`, result)
          const history = await calls(ctx)
          await save(`${kind}-${trial}-calls.json`, history)
          const events = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
          const usage = events.filter(event => event.type === 'step_finish').map(event => ({ tokens: event.part?.tokens, reportedCost: event.part?.cost }))
          report.agentTrials ??= []
          report.agentTrials.push({ kind, trial, usage })
          await save(`${kind}-${trial}-events.json`, events)
          const waste = analyzeWaste({ calls: history, events, kind })
          report.agentTrials.at(-1).waste = waste
          await save(`${kind}-${trial}-waste.json`, waste)
          assert.equal(result.code, 0, `OpenCode failed (${result.code}): ${result.stderr}`)
          const loaded = events.some(event => event.type === 'tool_use' && event.part?.tool === 'skill' && event.part?.state?.input?.name === 'gscdump' && event.part?.state?.status === 'completed')
          const text = events.filter(event => event.type === 'text').map(event => event.part?.text ?? '').join('\n')
          const grade = gradeAgent({ calls: history, loaded, kind, text })
          report.agentTrials.at(-1).processGrade = grade
          if (kind !== 'consent') {
            const query = history.findLast(call => call.args[0] === 'query' && !call.args.includes('--explain') && !call.args.includes('--help'))
            assert(query, 'The agent did not run a query.')
            const expected = await ctx.setup(['query', '--live', '--site', site, '--start', start, '--end', end, '--dimensions', 'page', '--limit', '1000', '--format', 'json', '--quiet'])
            compareRows(pageMetrics(rows(query.stdout)), pageMetrics(rows(expected)))
            report.agentTrials.at(-1).dataOutcome = 'passed'
          }
          assert(grade.passed, grade.failures.join(' '))
          return { usage, grade }
        })
      }
    }
  }
}
catch (error) {
  report.results.push({ id: 'harness', status: 'failed', reason: redact(error.message) })
}
finally {
  if (options.agents) {
    const summary = await run(process.execPath, [join(root, 'scripts/evals/summarize.mjs'), output])
    if (summary.code !== 0)
      report.results.push({ id: 'findings-report', status: 'failed', reason: redact(summary.stderr) })
  }
  report.finishedAt = new Date().toISOString()
  await save('report.json', report)
  await rm(temporary, { recursive: true, force: true })
}
console.log(`Evidence: ${output}`)
console.log(JSON.stringify(report.results.map(({ id, status }) => ({ id, status })), null, 2))
process.exitCode = report.results.every(result => result.status === 'passed') ? 0 : 1
