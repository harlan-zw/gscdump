import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), 'gscdump-packed-cli-'))
const consumer = join(temporary, 'consumer')
const config = join(consumer, 'config')
const artifacts = join(temporary, 'packages')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

try {
  await mkdir(config, { recursive: true })
  await mkdir(artifacts)
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  await writeFile(join(config, 'config.json'), JSON.stringify({ dataDir: join(consumer, 'data') }))
  await cp(join(root, 'tests/fixtures/packed-cli/google.mjs'), join(consumer, 'google.mjs'))

  // Install only the CLI's runtime package graph. Workspace peers cannot fill missing dependencies.
  const packed = new Map()
  async function pack(directory) {
    const cwd = join(root, 'packages', directory)
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'))
    if (packed.has(pkg.name))
      return
    const tarball = join(artifacts, `${directory}.tgz`)
    packed.set(pkg.name, tarball)
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
      if (version.startsWith('workspace:'))
        await pack(name === 'gscdump' ? name : name.slice('@gscdump/'.length))
    }
    await execute(pnpm, ['--config.ignore-scripts=true', 'pack', '--out', tarball], { cwd })
  }
  await pack('cli')
  await execute(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...packed.values()], {
    cwd: consumer,
    maxBuffer: 4 * 1024 * 1024,
  })

  const env = { ...process.env, GSC_ACCESS_TOKEN: 'packed-cli-fixture' }
  for (const name of Object.keys(env)) {
    if (name.startsWith('GOOGLE_') || name.startsWith('GSCDUMP_') || (name.startsWith('GSC_') && name !== 'GSC_ACCESS_TOKEN'))
      delete env[name]
  }
  delete env.NODE_OPTIONS
  delete env.NODE_PATH

  async function cli(...args) {
    const { stdout } = await execute(process.execPath, [
      '--import',
      join(consumer, 'google.mjs'),
      join(consumer, 'node_modules/@gscdump/cli/bin/gscdump.mjs'),
      '--config-dir',
      config,
      '--no-color',
      ...args,
    ], { cwd: consumer, env, maxBuffer: 4 * 1024 * 1024 })
    return stdout
  }

  const reports = JSON.parse(await cli('report', 'list', '--json'))
  assert(reports.some(report => report.id === 'movers'))
  const explained = JSON.parse(await cli('report', 'movers', '--explain'))
  assert.equal(explained.id, 'movers')
  assert(explained.plan.length > 0)

  await cli('sync', '--help')
  await cli('analyze', '--help')
  const site = 'sc-domain:example.com'
  const range = ['--site', site, '--start', '2026-08-01', '--end', '2026-08-01']
  await cli('sync', ...range, '--tables', 'pages', '--no-rollups', '--quiet')
  await cli('sync', ...range, '--tables', 'pages', '--no-rollups', '--quiet')
  const { data: rows } = JSON.parse(await cli('query', ...range, '--dimensions', 'page', '--format', 'json', '--quiet'))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].clicks, 5)
  assert.equal(rows[0].impressions, 50)
  console.log('Packed CLI: Reports, sync, repeated sync, and stored query passed.')
}
finally {
  await rm(temporary, { recursive: true, force: true })
}
