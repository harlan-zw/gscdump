import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resetNodeDuckDB } from '@gscdump/engine/node'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadInspectionHistory, syncInspections } from '../src/local-entities'
import { createLocalStore } from '../src/local-store'
import { openQuotaLedger } from '../src/quota-ledger'

const SITE = 'https://example.com/'
const NOW = new Date('2026-09-22T17:00:00Z')

afterAll(() => {
  resetNodeDuckDB()
})

describe('syncInspections under the quota ledger', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-inspect-quota-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('keeps the results it got, and stops for the day on a quota refusal', async () => {
    const store = createLocalStore({ dataDir: dir })
    const ctx = { userId: store.userId, siteId: store.siteIdFor(SITE) }
    const ledger = await openQuotaLedger({ dataDir: dir, now: () => NOW })
    let calls = 0
    const inspect = vi.fn(async () => {
      calls++
      if (calls > 25) {
        throw Object.assign(new Error('429'), {
          status: 429,
          data: { error: { code: 429, message: 'Quota exceeded for quota metric \'Inspection requests\'.', errors: [{ reason: 'rateLimitExceeded' }] } },
        })
      }
      return { inspectionResult: { indexStatusResult: { verdict: 'PASS' } } }
    })
    const candidates = Array.from({ length: 45 }, (_, i) => `${SITE}page-${i}`)
    const run = () => syncInspections({ client: { inspect } as never, dataSource: store.dataSource, ctx, siteUrl: SITE, candidates, limit: 45, concurrency: 1, ledger, now: () => NOW })

    const result = await run()

    expect(result).toMatchObject({ _tag: 'inspected', inspected: 25, deferred: 20, stopped: { reason: '429 Quota exceeded for quota metric \'Inspection requests\'.' } })
    expect(await loadInspectionHistory(store.dataSource, ctx)).toHaveLength(25)
    expect(ledger.status('urlInspection', SITE).used).toBe(25)

    inspect.mockClear()
    expect((await run())._tag).toBe('quota_exhausted')
    expect(inspect).not.toHaveBeenCalled()
  })
})
