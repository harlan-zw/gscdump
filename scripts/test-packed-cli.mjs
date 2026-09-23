import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), 'gscdump packed cli & fixtures-'))
const consumer = join(temporary, 'consumer project')
const config = join(consumer, 'config')
const artifacts = join(temporary, 'packages')
const runtimeHome = join(temporary, 'home')
const httpTrace = join(consumer, 'http-requests.ndjson')
// pnpm 12 provides a native executable. Windows cannot execute .cmd shims with execFile.
const pnpm = process.env.npm_execpath || (process.platform === 'win32' ? 'pnpm.exe' : 'pnpm')
const npmCli = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')

function runNpm(args, options) {
  // setup-node installs npm beside node.exe. Invoke its JavaScript entrypoint without a shell.
  return process.platform === 'win32'
    ? execute(process.execPath, [npmCli, ...args], options)
    : execute('npm', args, options)
}

try {
  await mkdir(config, { recursive: true })
  await mkdir(artifacts)
  await mkdir(runtimeHome)
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
  await runNpm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', ...packed.values()], {
    cwd: consumer,
    maxBuffer: 4 * 1024 * 1024,
  })

  const size = await measureInstallation()
  console.log(`Packed CLI size (bytes): ${JSON.stringify(size)}`)

  // A developer's cached DuckDB extensions must not hide a missing runtime dependency.
  const env = {
    ...process.env,
    HOME: runtimeHome,
    USERPROFILE: runtimeHome,
    XDG_CONFIG_HOME: join(runtimeHome, 'config'),
    XDG_CACHE_HOME: join(runtimeHome, 'cache'),
    XDG_DATA_HOME: join(runtimeHome, 'data'),
    GSC_ACCESS_TOKEN: 'packed-cli-fixture',
    PACKED_CLI_REQUESTS: httpTrace,
  }
  for (const name of Object.keys(env)) {
    if (name.startsWith('GOOGLE_') || name.startsWith('GSCDUMP_') || name.startsWith('BING_') || name.startsWith('DUCKDB_') || (name.startsWith('GSC_') && name !== 'GSC_ACCESS_TOKEN'))
      delete env[name]
  }
  delete env.NODE_OPTIONS
  delete env.NODE_PATH

  async function cli(...args) {
    const { stdout } = await execute(process.execPath, [
      '--import',
      pathToFileURL(join(consumer, 'google.mjs')).href,
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
  await cli('sync', ...range, '--tables', 'pages', '--types', 'web', '--no-rollups', '--quiet')
  await cli('sync', ...range, '--tables', 'pages', '--types', 'web', '--no-rollups', '--quiet')
  const { data: rows } = JSON.parse(await cli('query', ...range, '--dimensions', 'page', '--format', 'json', '--quiet'))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].clicks, 5)
  assert.equal(rows[0].impressions, 50)

  const parquetDirectory = join(consumer, 'exported parquet')
  const dumped = JSON.parse(await cli('dump', '--site', site, '--tables', 'pages', '--format', 'parquet', '--out', parquetDirectory, '--json'))
  assert.equal(dumped.sites[0].files.length, 1)
  assert(dumped.sites[0].files[0].bytes > 0)
  // Sync saved the sitemap and one URL Inspection; dump exports both with sizes.
  const entityDump = JSON.parse(await cli('dump', '--site', site, '--tables', 'inspections,sitemaps,sitemap_urls', '--format', 'json', '--out', join(consumer, 'exported entities'), '--json'))
  assert.deepEqual(Object.fromEntries(entityDump.sites[0].files.map(file => [file.dataset, file.rows])), { inspections: 1, sitemaps: 1, sitemap_urls: 1 })
  assert(entityDump.metadataFiles.some(file => file.path.endsWith('manifest.json')))
  const duckdbFile = join(consumer, 'exported store.duckdb')
  const exported = JSON.parse(await cli('store', 'export', '--site', site, '--out', duckdbFile, '--json'))
  assert.equal(exported.tables.find(table => table.table === 'pages').rows, 1)
  assert.deepEqual(exported.tables.filter(table => ['inspections', 'sitemaps', 'sitemap_urls'].includes(table.table)).map(table => table.rows), [1, 1, 1])
  assert(exported.bytes > 0)

  // Reopen portable exports after removing the Store, using only installed production dependencies.
  await rm(join(consumer, 'data'), { recursive: true })
  await execute(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import { DuckDBInstance } from '@duckdb/node-api'
    const expected = [{ url: '/guide', date: '2026-08-01', clicks: 5, impressions: 50 }]
    const columns = 'url, CAST(date AS VARCHAR) AS date, clicks::INTEGER AS clicks, impressions::INTEGER AS impressions'
    for (const [path, source] of [
      [':memory:', "read_parquet('exported parquet/**/*.parquet')"],
      ['exported store.duckdb', 'pages'],
    ]) {
      const instance = await DuckDBInstance.create(path)
      const connection = await instance.connect()
      try {
        const result = await connection.runAndReadAll('SELECT ' + columns + ' FROM ' + source)
        assert.deepEqual(result.getRowObjects(), expected)
      }
      finally {
        connection.closeSync()
        instance.closeSync()
      }
    }
  `], { cwd: consumer, env })
  console.log('Packed CLI: Reports, sync, repeated sync, stored query, Parquet export, and DuckDB export passed.')

  const localBingSite = 'https://local-bing.example.com/'
  await cli('bing', 'login', '--mode', 'local', '--api-key', 'packed-bing-key', '--json')
  const localBingSites = JSON.parse(await cli('bing', 'sites', '--json'))
  assert.equal(localBingSites.sites[0].url, localBingSite)
  const localBingDump = JSON.parse(await cli('bing', 'dump', '--site', localBingSite, '--datasets', 'traffic,keywords', '--out', join(consumer, 'local Bing export'), '--json'))
  const localTraffic = JSON.parse(await readFile(localBingDump.files.find(file => file.dataset === 'traffic').path, 'utf8'))
  const localQueries = JSON.parse(await readFile(localBingDump.files.find(file => file.dataset === 'keywords').path, 'utf8'))
  assert.deepEqual(localTraffic.map(({ clicks, impressions }) => ({ clicks, impressions })), [{ clicks: 12, impressions: 80 }])
  assert.equal(localQueries[0].query, 'local search')

  // One saved Cloud login must route both Search Engines in later processes.
  await writeFile(httpTrace, '')
  await cli('auth', 'login', '--mode', 'cloud', '--api-key', 'gsd_user_packed_fixture', '--json')
  const cloudSite = 'sc-domain:cloud.example.com'
  const cloudGoogleSites = JSON.parse(await cli('sites', '--json'))
  assert.equal(cloudGoogleSites[0].siteUrl, cloudSite)
  const cloudQuery = JSON.parse(await cli('query', '--live', '--site', cloudSite, '--start', '2026-08-01', '--end', '2026-08-01', '--dimensions', 'page', '--format', 'json', '--quiet'))
  assert.equal(cloudQuery.data[0].clicks, 9)
  assert.equal(cloudQuery.data[0].impressions, 90)
  const cloudBingSites = JSON.parse(await cli('bing', 'sites', '--json'))
  assert.equal(cloudBingSites.sites[0].siteId, 's_packed')
  assert.equal(cloudBingSites.sites[0].connection._tag, 'connected')
  const cloudBingDump = JSON.parse(await cli('bing', 'dump', '--site', 's_packed', '--start', '2026-08-01', '--end', '2026-08-31', '--datasets', 'traffic,keywords', '--format', 'ndjson', '--out', join(consumer, 'cloud Bing export'), '--json'))
  for (const file of cloudBingDump.files) {
    const rows = (await readFile(file.path, 'utf8')).trim().split('\n').map(row => JSON.parse(row))
    assert.equal(rows.length, 501)
    assert.equal(rows.at(-1).clicks, 510)
    assert.equal(file.sync._tag, 'ready')
    if (file.dataset === 'keywords')
      assert.equal(rows.at(-1).query, 'cloud search 500')
  }
  const hostedRequests = (await readFile(httpTrace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert(hostedRequests.every(request => request.origin === 'https://gscdump.com'))
  assert.deepEqual(hostedRequests.filter(request => request.pathname.endsWith('/bing/data')).map(request => request.offset), ['0', '500', '0', '500'])

  // A local override uses saved Bing credentials and leaves the Cloud login selected afterward.
  await writeFile(httpTrace, '')
  const overriddenBingSites = JSON.parse(await cli('bing', 'sites', '--mode', 'local', '--json'))
  assert.equal(overriddenBingSites.sites[0].url, localBingSite)
  const overriddenGoogleSites = JSON.parse(await cli('sites', '--mode', 'local', '--json'))
  assert.equal(overriddenGoogleSites[0].siteUrl, site)
  const localRequests = (await readFile(httpTrace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert(localRequests.every(request => request.origin !== 'https://gscdump.com'))
  const stillCloud = JSON.parse(await cli('bing', 'sites', '--json'))
  assert.equal(stillCloud.sites[0].siteId, 's_packed')
  console.log('Packed CLI: saved local Bing login/dump, shared Cloud Google/Bing queries, pagination, and local mode overrides passed.')

  if (process.platform === 'linux' && process.arch === 'x64') {
    assert(size.installedFileBytes <= 135_000_000, `Packed CLI exceeds 135 MB installed: ${(size.installedFileBytes / 1_000_000).toFixed(2)} MB`)
  }

  async function measureInstallation() {
    const lock = JSON.parse(await readFile(join(consumer, 'package-lock.json'), 'utf8'))
    const npmCache = (await runNpm(['config', 'get', 'cache'], { cwd: consumer })).stdout.trim()
    const packages = []
    async function fileBytes(directory) {
      let bytes = 0
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        // Nested packages get their own lockfile entry. Exclude metadata and executable symlinks.
        if (entry.name === 'node_modules')
          continue
        const path = join(directory, entry.name)
        if (entry.isDirectory())
          bytes += await fileBytes(path)
        else if (entry.isFile())
          bytes += (await stat(path)).size
      }
      return bytes
    }
    for (const [path, pkg] of Object.entries(lock.packages)) {
      if (!path)
        continue
      const installed = await stat(join(consumer, path)).catch((error) => {
        // npm lists unavailable optional platforms in its lockfile without installing their files.
        if (error.code === 'ENOENT')
          return undefined
        throw error
      })
      if (!installed?.isDirectory())
        continue
      let tarball
      if (pkg.resolved?.startsWith('file:')) {
        tarball = fileURLToPath(new URL(pkg.resolved, pathToFileURL(`${consumer}/`)))
      }
      else {
        const integrity = /^(sha512|sha1)-([^ ]+)/.exec(pkg.integrity ?? '')
        assert(integrity, `Missing tarball integrity for ${path}`)
        const hex = Buffer.from(integrity[2], 'base64').toString('hex')
        tarball = join(npmCache, '_cacache', 'content-v2', integrity[1], hex.slice(0, 2), hex.slice(2, 4), hex.slice(4))
      }
      packages.push({
        name: path.split('node_modules/').at(-1),
        version: pkg.version,
        installedFileBytes: await fileBytes(join(consumer, path)),
        compressedTarballBytes: (await stat(tarball)).size,
      })
    }
    packages.sort((a, b) => b.installedFileBytes - a.installedFileBytes)
    const total = entries => ({
      installedFileBytes: entries.reduce((bytes, pkg) => bytes + pkg.installedFileBytes, 0),
      compressedTarballBytes: entries.reduce((bytes, pkg) => bytes + pkg.compressedTarballBytes, 0),
    })
    // File payload excludes directory metadata. Tarball payload excludes HTTP headers and absent platforms.
    return {
      platform: `${process.platform}-${process.arch}`,
      packages: packages.length,
      ...total(packages),
      largestPackages: packages.slice(0, 10),
      remainingPackages: total(packages.slice(10)),
    }
  }
}
finally {
  await rm(temporary, { recursive: true, force: true })
}
