/**
 * Layer API surface metric: keep the layer narrow.
 *
 * Counts source files in `packages/nuxt-analytics` and asserts the total
 * stays under a budget. Crossing the budget is a smell, not a hard error
 * — when intentional, bump the cap in this test alongside the change. The
 * goal is to surface inadvertent layer growth (e.g. someone porting a
 * page-specific helper into the layer instead of the host).
 *
 * Excludes `dist`, `node_modules`, `.nuxt`. Counts `.ts` + `.vue`.
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const LAYER_DIR = join(process.cwd(), 'packages/nuxt-analytics')
const FILE_BUDGET = 90
const SKIP_DIRS = new Set(['node_modules', 'dist', '.nuxt'])

async function countSourceFiles(dir: string): Promise<number> {
  let count = 0
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name))
        continue
      count += await countSourceFiles(join(dir, entry.name))
      continue
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.vue'))
      count++
  }
  return count
}

describe('layer file-count budget', () => {
  it(`@gscdump/nuxt-analytics stays under ${FILE_BUDGET} source files`, async () => {
    const count = await countSourceFiles(LAYER_DIR)
    expect(count).toBeLessThanOrEqual(FILE_BUDGET)
  })
})
