import type { DataSource } from '@gscdump/engine/contracts'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createInspectionStore } from '@gscdump/engine/entities'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { toInspectionRecord } from '../src/inspection-record'
import { loadInspectionState, recordInspections } from '../src/local-entities'
import { createLocalStore } from '../src/local-store'

const NOW = new Date('2026-09-20T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

function inspected(url: string, daysAgo: number, verdict: string) {
  return toInspectionRecord({ url, result: { indexStatusResult: { verdict } }, inspectedAt: new Date(NOW.getTime() - daysAgo * DAY) })
}

describe('loadInspectionState', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-inspection-state-'))
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('plans from the index and reads only the history months of the last 24 hours', async () => {
    const store = createLocalStore({ dataDir })
    const ctx = { userId: store.userId, siteId: store.siteIdFor('sc-domain:e.com') }
    const old = inspected('https://e.com/old', 120, 'FAIL')
    await recordInspections(store.dataSource, ctx, new Map(), [old])
    const today = inspected('https://e.com/today', 0.25, 'PASS')
    await recordInspections(store.dataSource, ctx, new Map([[old.url, old]]), [today])

    const reads: string[] = []
    const dataSource: DataSource = {
      ...store.dataSource,
      read: (key, ...rest) => {
        reads.push(key)
        return store.dataSource.read(key, ...rest)
      },
    }
    const state = await loadInspectionState(dataSource, ctx, NOW)

    expect(reads.some(key => key.includes('/2026-05/'))).toBe(false)
    expect(state.recent.map(record => record.url)).toEqual(['https://e.com/today'])
    expect(state.latest.get(old.url)?.raw?.schedule).toEqual(old.raw?.schedule)
    expect(state.latest.get(old.url)?.indexStatus).toBe('FAIL')
    expect([...state.latest.keys()].sort()).toEqual(['https://e.com/old', 'https://e.com/today'])
  })

  it('falls back to the full history when no index exists', async () => {
    const store = createLocalStore({ dataDir })
    const ctx = { userId: store.userId, siteId: store.siteIdFor('sc-domain:e.com') }
    await createInspectionStore({ dataSource: store.dataSource }).appendHistory(ctx, [inspected('https://e.com/old', 120, 'FAIL')])

    const state = await loadInspectionState(store.dataSource, ctx, NOW)

    expect([...state.latest.keys()]).toEqual(['https://e.com/old'])
  })
})
