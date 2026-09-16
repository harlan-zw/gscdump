import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const docsRoot = fileURLToPath(new URL('.', import.meta.url))

async function rateLimitTableRowCount(): Promise<number> {
  const contract = await readFile(`${docsRoot}hosted-api-v1.md`, 'utf8')
  const section = contract.split(/^## /m).find(chunk => chunk.startsWith('Rate limits and lifecycle signaling'))
  if (!section)
    throw new Error('missing "## Rate limits and lifecycle signaling" section in docs/hosted-api-v1.md')
  const rows = [...section.matchAll(/^\| `[a-z][a-z0-9._]*` \|/gm)].map(match => match[0])
  if (rows.length === 0)
    throw new Error('rate-limit table has no operation rows')
  return rows.length
}

describe('hosted-v1 guide doc consistency', () => {
  it('quotes the real rate-limit policy count from the contract table', async () => {
    const [guide, tableRows] = await Promise.all([
      readFile(`${docsRoot}guides/hosted-v1.md`, 'utf8'),
      rateLimitTableRowCount(),
    ])
    const quoted = guide.match(/lists all (\d+) operation policies/)?.[1]
    expect(quoted, `guide quotes "${quoted}" but the contract table has ${tableRows} rows`).toBe(
      String(tableRows),
    )
  })
})
