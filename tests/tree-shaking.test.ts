import type { OutputChunk } from 'rolldown'
import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { rolldown } from 'rolldown'
import { describe, expect, it } from 'vitest'

interface TreeShakeCase {
  entry: string
  exportName: string
  maxBytes: number
  allowedImports?: readonly string[]
  allowedDynamicImports?: readonly string[]
  expectAsyncChunks?: boolean
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
    entry: 'packages/lakehouse/dist/index.mjs',
    exportName: 'toIcebergDayCount',
    maxBytes: 500,
  },
  {
    entry: 'packages/lakehouse/dist/date.mjs',
    exportName: 'toIcebergDayCount',
    maxBytes: 500,
  },
  {
    entry: 'packages/lakehouse/dist/dataset.mjs',
    exportName: 'defineIcebergDataset',
    maxBytes: 10_000,
    expectAsyncChunks: true,
  },
  {
    entry: 'packages/contracts/dist/v1/realtime.mjs',
    exportName: 'createRealtimeV1Schemas',
    maxBytes: 12_000,
    allowedImports: ['zod'],
  },
  {
    entry: 'packages/contracts/dist/v1/browser.mjs',
    exportName: 'createGscdumpV1BrowserSchemas',
    maxBytes: 25_000,
    allowedImports: ['zod'],
  },
  {
    entry: 'packages/contracts/dist/v1/http.mjs',
    exportName: 'createGscdumpV1Protocol',
    maxBytes: 125_000,
    allowedImports: ['zod'],
  },
  {
    entry: 'packages/sdk/dist/v1/http.mjs',
    exportName: 'createGscdumpV1Client',
    maxBytes: 12_000,
    allowedDynamicImports: ['@gscdump/contracts/v1/http'],
  },
  {
    entry: 'packages/sdk/dist/v1/realtime.mjs',
    exportName: 'createGscdumpRealtimeV1Client',
    maxBytes: 20_000,
    allowedImports: ['@gscdump/contracts/v1/realtime'],
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
  asyncChunks: number
  bytes: number
  dynamicImports: string[]
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
    codeSplitting: true,
    minify: true,
  })
  await bundle.close()

  const chunks = output.filter((item): item is OutputChunk => item.type === 'chunk')
  const chunksByFile = new Map(chunks.map(chunk => [chunk.fileName, chunk]))
  const initialChunks = new Set(chunks.filter(chunk => chunk.isEntry))
  for (const chunk of initialChunks) {
    for (const imported of chunk.imports) {
      const dependency = chunksByFile.get(imported)
      if (dependency)
        initialChunks.add(dependency)
    }
  }
  return {
    asyncChunks: chunks.length - initialChunks.size,
    bytes: [...initialChunks].reduce((total, chunk) => total + Buffer.byteLength(chunk.code), 0),
    dynamicImports: [...new Set(
      [...initialChunks].flatMap(chunk =>
        [...chunk.code.matchAll(/\bimport\((['"`])([^'"`]+)\1\)/g)]
          .map(match => match[2]!)
          .filter(imported => !imported.startsWith('.')),
      ),
    )].sort(),
    imports: [...new Set(
      [...initialChunks].flatMap(chunk => chunk.imports.filter(imported => !chunksByFile.has(imported))),
    )].sort(),
  }
}

describe('published tree shaking', () => {
  for (const testCase of cases) {
    it.skipIf(!existsSync(testCase.entry))(`${testCase.entry} isolates ${testCase.exportName}`, async () => {
      const result = await bundleExport(testCase)
      expect(result.bytes).toBeLessThanOrEqual(testCase.maxBytes)
      expect(result.imports).toEqual([...(testCase.allowedImports ?? [])].sort())
      expect(result.dynamicImports).toEqual([...(testCase.allowedDynamicImports ?? [])].sort())
      if (testCase.expectAsyncChunks)
        expect(result.asyncChunks).toBeGreaterThan(0)
    })
  }
})
