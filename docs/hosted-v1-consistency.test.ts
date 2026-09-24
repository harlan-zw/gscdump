import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { listHttpOperations } from '../packages/contracts/src/v1/http-core'
import { createGscdumpV1Protocol } from '../packages/contracts/src/v1/operations'

const docsRoot = fileURLToPath(new URL('.', import.meta.url))

const numberWords = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

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

function publicNeverRetryOperationIds(): string[] {
  return listHttpOperations(createGscdumpV1Protocol())
    .filter(entry => entry.operation.visibility === 'public' && entry.operation.semantics.retry === 'never')
    .map(entry => entry.operation.id)
    .sort()
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

  it('lists every public retry-never operation from the registry', async () => {
    const doc = await readFile(`${docsRoot}gscdump-sdk/api/2.hosted-http.md`, 'utf8')
    const section = doc.split(/^## /m).find(chunk => chunk.startsWith('Idempotency and retries'))
    if (!section)
      throw new Error('missing "## Idempotency and retries" section in docs/gscdump-sdk/api/2.hosted-http.md')
    const registryIds = publicNeverRetryOperationIds()
    const bullets = [...section.matchAll(/^- `([a-z][a-z0-9._]+)`$/gm)].map(match => match[1]).sort()
    const countWord = section.match(/^(\w+) mutations are non-idempotent/m)?.[1]?.toLowerCase()
    expect(countWord, `doc says "${countWord}" mutations but the registry has ${registryIds.length}`).toBe(
      numberWords[registryIds.length],
    )
    expect(bullets, 'doc list does not match the public retry:"never" registry operations').toEqual(registryIds)
  })
})
