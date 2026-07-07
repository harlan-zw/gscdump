/**
 * Guard: no raw `JSON.stringify` on a storage-write path.
 *
 * BigInt identity ids (iceberg snapshot ids, D1 row ids) reach these boundaries
 * uncoerced, and a plain `JSON.stringify` throws `Do not know how to serialize a
 * BigInt` — a request 500. Every serialize-to-bytes-then-write site must funnel
 * through `encodeJsonBigintSafe` / `writeJson` / `stringifyBigintSafe` instead.
 *
 * This test fails if the `new TextEncoder().encode(JSON.stringify(...))` pattern
 * reappears in engine or lakehouse source, so the abstraction can't silently rot.
 */

import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const SRC_DIRS = [
  join(here, '..', 'src'), // @gscdump/engine
  join(here, '..', '..', 'lakehouse', 'src'), // @gscdump/lakehouse
]

// The serialize-to-storage-bytes pattern. `encodeJsonBigintSafe` is the only
// sanctioned way to produce write bytes from an object.
const FORBIDDEN = /TextEncoder\(\)\.encode\(\s*JSON\.stringify\(/

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory())
      files.push(...await walk(full))
    else if (e.name.endsWith('.ts'))
      files.push(full)
  }
  return files
}

describe('no raw JSON.stringify on storage-write paths', () => {
  it('all serialize-to-write sites funnel through the BigInt-safe helper', async () => {
    const offenders: string[] = []
    for (const dir of SRC_DIRS) {
      for (const file of await walk(dir)) {
        const src = await readFile(file, 'utf8')
        src.split('\n').forEach((line, i) => {
          if (FORBIDDEN.test(line))
            offenders.push(`${file}:${i + 1}  ${line.trim()}`)
        })
      }
    }
    expect(
      offenders,
      `Use encodeJsonBigintSafe(value) / writeJson(ds, key, value) instead of TextEncoder().encode(JSON.stringify(...)) — a stray BigInt id throws and 500s the request.\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})
