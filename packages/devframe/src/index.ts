import type { DevframeDefinition } from 'devframe'
import type { HostedSourceOptions } from './sources/hosted'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { defineDevframe } from 'devframe'
import pkg from '../package.json' with { type: 'json' }
import { createPageStatsReader } from './reader'
import { createRpcFunctions } from './rpc'
import { DEVFRAME_ID } from './shared/protocol'
import { createHostedSource } from './sources/hosted'

export interface GscdumpDevframeOptions extends HostedSourceOptions {
  /** The Site to read: a Site ID, a Site URL, or its host. Optional when the credential holds one Site. */
  site?: string
  /** Override the request implementation, for proxies and tests. */
  fetch?: typeof fetch
}

/**
 * The built panel and page script ship in this package's `dist/`. Resolve them
 * through the package's own `package.json`, so the path holds from source, from
 * the build, and under a bundler that moves this module into a shared chunk.
 */
function packageDir(): string {
  return dirname(createRequire(import.meta.url).resolve(`${pkg.name}/package.json`))
}

/** The CLI saves its Hosted login here. `GSCDUMP_CONFIG_DIR` moves it, as it does for the CLI. */
async function readCliAuthentication(env: Record<string, string | undefined>): Promise<unknown> {
  const dir = env.GSCDUMP_CONFIG_DIR ?? join(homedir(), '.config', 'gscdump')
  const body = await readFile(join(dir, 'authentication.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return null
    throw error
  })
  return body === null ? null : JSON.parse(body)
}

/**
 * The gscdump devframe: Search Console clicks, impressions, CTR, position, and
 * top queries for the page in view, read from the gscdump Hosted record.
 *
 * Mount it in Vite DevTools with `@gscdump/devframe/vite`, or pass it to any
 * devframe hub.
 */
export function createGscdumpDevframe(options: GscdumpDevframeOptions = {}): DevframeDefinition {
  const dir = packageDir()
  return defineDevframe({
    id: DEVFRAME_ID,
    name: 'Search Console',
    version: pkg.version,
    packageName: pkg.name,
    importMetaUrl: import.meta.url,
    homepage: pkg.homepage,
    description: pkg.description,
    icon: 'ph:chart-line-up-duotone',
    clientAssets: join(dir, 'dist/client'),
    dock: {
      category: 'web',
      clientScript: { importFrom: join(dir, 'dist/client-script/index.mjs') },
    },
    // The panel reads live data through the node side. A static build has nothing to show.
    capabilities: { build: false },
    setup(ctx) {
      const env = process.env
      const source = createHostedSource(options, {
        fetch: options.fetch ?? globalThis.fetch,
        env,
        readCliAuthentication: () => readCliAuthentication(env),
      })
      const reader = createPageStatsReader({ site: options.site }, source, Date.now)
      const scoped = ctx.scope(DEVFRAME_ID)
      for (const fn of createRpcFunctions(reader))
        scoped.rpc.register(fn)
    },
  })
}

export default createGscdumpDevframe

export type { DailyPoint, DateWindow, GscdumpContext, MetricTotals, PageStats, PageStatsInput, Period, QueryRow, SiteSummary } from './shared/protocol'
export type { HostedSourceOptions } from './sources/hosted'
