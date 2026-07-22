import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

async function staticClosure(entry: string): Promise<{ bytes: number, external: Set<string> }> {
  const queue = [entry]
  const seen = new Set<string>()
  const external = new Set<string>()
  let bytes = 0

  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file))
      continue
    seen.add(file)
    const source = await readFile(file, 'utf8')
    bytes += Buffer.byteLength(source)
    for (const match of source.matchAll(/(?:from\s+|import\s+)(['"])([^'"]+)\1/g)) {
      const specifier = match[2]!
      if (specifier.startsWith('.'))
        queue.push(resolve(dirname(file), specifier))
      else
        external.add(specifier)
    }
  }

  return { bytes, external }
}

const built = existsSync(join(root, 'packages/engine/dist/index.mjs'))

describe.skipIf(!built)('published import graph budgets', () => {
  it('keeps the engine storage root focused', async () => {
    const closure = await staticClosure(join(root, 'packages/engine/dist/index.mjs'))
    expect(closure.bytes).toBeLessThan(100_000)
    expect(closure.external).not.toContain('@gscdump/lakehouse')
  })

  it('keeps utility seams standalone', async () => {
    const entries = [
      ['packages/engine/dist/entity-keys.mjs', 5_000],
      ['packages/lakehouse/dist/bigint.mjs', 1_000],
      ['packages/lakehouse/dist/schema.mjs', 500],
      ['packages/analysis/dist/source/index.mjs', 5_000],
      ['packages/sdk/dist/period.mjs', 10_000],
    ] as const

    for (const [path, budget] of entries) {
      const closure = await staticClosure(join(root, path))
      expect(closure.bytes, path).toBeLessThan(budget)
    }
  })

  it('shares gscdump chunks across public entries', async () => {
    const dist = join(root, 'packages/gscdump/dist')
    const files = await readdir(dist, { recursive: true })
    const modules = files.filter(file => file.endsWith('.mjs'))
    const sizes = await Promise.all(modules.map(file => stat(join(dist, file))))
    expect(sizes.reduce((total, file) => total + file.size, 0)).toBeLessThan(190_000)
  })
})
