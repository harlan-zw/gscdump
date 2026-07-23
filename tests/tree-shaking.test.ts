import type { OutputChunk } from 'rolldown'
import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { rolldown } from 'rolldown'

interface TreeShakeCase {
  entry: string
  exportName: string
  maxBytes: number
  allowedImports?: readonly string[]
}

const cases: readonly TreeShakeCase[] = [
  { entry: 'packages/gscdump/dist/index.mjs', exportName: 'MS_PER_DAY', maxBytes: 100 },
  {
    entry: 'packages/engine/dist/index.mjs',
    exportName: 'DEFAULT_SEARCH_TYPE',
    maxBytes: 100,
    allowedImports: ['gscdump/dates'],
  },
  {
    entry: 'packages/engine-duckdb-wasm/dist/index.mjs',
    exportName: 'overlayViewBody',
    maxBytes: 1_000,
  },
  {
    entry: 'packages/engine-gsc-api/dist/index.mjs',
    exportName: 'canProxyToGsc',
    maxBytes: 500,
    allowedImports: ['gscdump'],
  },
  {
    entry: 'packages/engine-sqlite/dist/index.mjs',
    exportName: 'aggClicks',
    maxBytes: 500,
    allowedImports: ['drizzle-orm'],
  },
  { entry: 'packages/analysis/dist/index.mjs', exportName: 'createSorter', maxBytes: 500 },
  {
    entry: 'packages/contracts/dist/index.mjs',
    exportName: 'hasRequiredAnalyticsScope',
    maxBytes: 1_000,
  },
  {
    entry: 'packages/sdk/dist/index.mjs',
    exportName: 'GSC_STABLE_LATENCY_DAYS',
    maxBytes: 100,
  },
  {
    entry: 'packages/cloudflare/dist/index.mjs',
    exportName: 'getHostedR2QueryKey',
    maxBytes: 1_000,
  },
  {
    entry: 'packages/lakehouse/dist/index.mjs',
    exportName: 'DEFAULT_PARTITION_KEY_ENCODING',
    maxBytes: 100,
  },
  {
    entry: 'packages/cli/dist/index.mjs',
    exportName: 'createCliRuntime',
    maxBytes: 1_000,
    allowedImports: [
      'consola',
      'node:async_hooks',
      'node:os',
      'node:path',
      'node:process',
    ],
  },
]

async function bundleExport(testCase: TreeShakeCase): Promise<{
  bytes: number
  imports: string[]
}> {
  const entry = resolve(testCase.entry)
  const bundle = await rolldown({
    cwd: process.cwd(),
    input: '#tree-shake-entry',
    logLevel: 'silent',
    platform: 'neutral',
    external: id =>
      id !== '#tree-shake-entry'
      && id !== entry
      && !id.startsWith('.')
      && !id.startsWith(process.cwd()),
    plugins: [{
      name: 'tree-shake-entry',
      resolveId(id) {
        if (id === '#tree-shake-entry')
          return id
      },
      load(id) {
        if (id === '#tree-shake-entry')
          return `export { ${testCase.exportName} } from ${JSON.stringify(entry)}`
      },
    }],
  })
  const { output } = await bundle.generate({
    codeSplitting: false,
    minify: true,
  })
  await bundle.close()

  const chunks = output.filter((item): item is OutputChunk => item.type === 'chunk')
  return {
    bytes: chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk.code), 0),
    imports: [...new Set(chunks.flatMap(chunk => chunk.imports))].sort(),
  }
}

describe('published tree shaking', () => {
  for (const testCase of cases) {
    it.skipIf(!existsSync(testCase.entry))(`${testCase.entry} isolates ${testCase.exportName}`, async () => {
      const result = await bundleExport(testCase)
      expect(result.bytes).toBeLessThanOrEqual(testCase.maxBytes)
      expect(result.imports).toEqual([...(testCase.allowedImports ?? [])].sort())
    })
  }
})
