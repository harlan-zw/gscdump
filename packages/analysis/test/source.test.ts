import type { Row, TableName } from '@gscdump/engine/contracts'
import type { GoogleSearchConsoleClient } from 'gscdump/api'
import type { GSCQueryBuilder } from 'gscdump/query'

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDuckDBCodec,
  createDuckDBExecutor,
  createStorageEngine,
} from '@gscdump/engine'
import { createGscApiQuerySource } from '@gscdump/engine-gsc-api'
import { runAnalyzerFromSource } from '@gscdump/engine/analyzer'
import {
  createFilesystemDataSource,
  createFilesystemManifestStore,
} from '@gscdump/engine/filesystem'
import {
  createNodeDuckDBHandle,
  resetNodeDuckDB,
} from '@gscdump/engine/node'
import { createEngineQuerySource, queryRows } from '@gscdump/engine/source'

import {
  and,
  between,
  clicks,
  date,
  eq,
  gsc,
  gte,
  impressions,
  or,
  page,
  query,
  regex,
  topLevel,
} from 'gscdump/query'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pagesQueryState, queriesQueryState } from '../src/analyzer/adapt-rows'
import { moversAnalyzer } from '../src/analyzers/movers'
import { defaultAnalyzerRegistry } from '../src/default-registry'
import { createInMemoryQuerySource } from '../src/source'

afterAll(() => {
  resetNodeDuckDB()
})

interface Seed {
  table: TableName
  date: string
  rows: Row[]
}

async function setupEngine(dir: string) {
  const handle = createNodeDuckDBHandle()
  const factory = { getDuckDB: async () => handle }
  const codec = createDuckDBCodec(factory)
  const executor = createDuckDBExecutor(factory)
  const dataSource = createFilesystemDataSource({ rootDir: dir })
  const manifestStore = createFilesystemManifestStore({ path: join(dir, 'manifest.json') })
  return createStorageEngine({ dataSource, manifestStore, codec, executor })
}

async function seed(engine: ReturnType<typeof createStorageEngine>, seeds: Seed[]): Promise<void> {
  for (const s of seeds)
    await engine.writeDay({ userId: 'u1', siteId: 's1', table: s.table, date: s.date }, s.rows)
}

describe('analysis sources', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gscdump-source-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('in-memory source fans rows out by builder dimensions', async () => {
    const source = createInMemoryQuerySource({
      queryRows(state) {
        if (state.dimensions.includes('query'))
          return [{ query: 'alpha', page: '/a', clicks: 10, impressions: 100, ctr: 0.1, position: 3 }]
        if (state.dimensions.includes('page'))
          return [{ page: '/a', clicks: 10, impressions: 100, ctr: 0.1, position: 3 }]
        return [{ date: '2026-04-10', clicks: 10, impressions: 100, ctr: 0.1, position: 3 }]
      },
    })

    const period = { startDate: '2026-04-10', endDate: '2026-04-10' }
    const [keywords, pages] = await Promise.all([
      queryRows(source, queriesQueryState(period, 100)),
      queryRows(source, pagesQueryState(period, 100)),
    ])

    expect(keywords[0].query).toBe('alpha')
    expect(pages[0].page).toBe('/a')
  })

  it('gsc api source applies analytics-only filters client-side', async () => {
    const client = {
      async* query(_siteUrl: string, builder: GSCQueryBuilder<any, any>) {
        const state = builder.getState()
        if (state.dimensions.includes('page')) {
          yield [
            { page: 'https://example.com/', clicks: 8, impressions: 50, ctr: 0.16, position: 2 },
            { page: 'https://example.com/blog/post', clicks: 12, impressions: 200, ctr: 0.06, position: 4 },
            { page: 'https://example.com/docs', clicks: 20, impressions: 300, ctr: 0.04, position: 5 },
          ]
        }
      },
    } as unknown as GoogleSearchConsoleClient

    const source = createGscApiQuerySource({ client, siteUrl: 'sc-domain:example.com' })
    const state = gsc
      .select(page)
      .where(and(
        between(date, '2026-04-01', '2026-04-30'),
        topLevel(page),
        gte(clicks, 10),
      ))
      .limit(1)
      .orderBy(clicks, 'desc')
      .getState()

    const rows = await queryRows(source, state)

    expect(rows).toHaveLength(1)
    expect(rows[0].page).toBe('https://example.com/docs')
  })

  it('gsc api source applies limit after collecting rows for client-side ordering', async () => {
    const client = {
      async* query(_siteUrl: string, builder: GSCQueryBuilder<any, any>) {
        const state = builder.getState()
        const candidates = [
          { page: 'https://example.com/low-impressions', clicks: 100, impressions: 10, ctr: 10, position: 1 },
          { page: 'https://example.com/high-impressions', clicks: 1, impressions: 1000, ctr: 0.001, position: 2 },
        ]
        const start = state.startRow ?? 0
        const end = state.rowLimit == null ? candidates.length : start + state.rowLimit
        yield candidates.slice(start, end)
      },
    } as unknown as GoogleSearchConsoleClient

    const source = createGscApiQuerySource({ client, siteUrl: 'sc-domain:example.com' })
    const state = gsc
      .select(page)
      .where(between(date, '2026-04-01', '2026-04-30'))
      .orderBy(impressions, 'desc')
      .limit(1)
      .getState()

    const rows = await queryRows(source, state)

    expect(rows).toHaveLength(1)
    expect(rows[0].page).toBe('https://example.com/high-impressions')
  })

  it('gsc api source preserves OR semantics during local dimension filtering', async () => {
    const client = {
      async* query() {
        yield [
          { page: 'https://example.com/a', clicks: 1, impressions: 10, ctr: 0.1, position: 1 },
          { page: 'https://example.com/b', clicks: 2, impressions: 20, ctr: 0.1, position: 2 },
          { page: 'https://example.com/c', clicks: 3, impressions: 30, ctr: 0.1, position: 3 },
        ]
      },
    } as unknown as GoogleSearchConsoleClient

    const source = createGscApiQuerySource({ client, siteUrl: 'sc-domain:example.com' })
    const state = gsc
      .select(page)
      .where(and(
        between(date, '2026-04-01', '2026-04-30'),
        or(eq(page, '/a'), eq(page, '/b')),
      ))
      .getState()

    const rows = await queryRows(source, state)

    expect(rows.map(row => row.page).sort()).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ])
  })

  it('gsc api source applies regex filters with regex semantics client-side', async () => {
    const client = {
      async* query() {
        yield [
          { page: 'https://example.com/blog/123', clicks: 8, impressions: 50, ctr: 0.16, position: 2 },
          { page: 'https://example.com/blog/abc', clicks: 12, impressions: 200, ctr: 0.06, position: 4 },
          { page: 'https://example.com/docs', clicks: 20, impressions: 300, ctr: 0.04, position: 5 },
        ]
      },
    } as unknown as GoogleSearchConsoleClient

    const source = createGscApiQuerySource({ client, siteUrl: 'sc-domain:example.com' })
    const state = gsc
      .select(page)
      .where(and(
        between(date, '2026-04-01', '2026-04-30'),
        regex(page, '^https://example.com/blog/\\d+$'),
      ))
      .getState()

    const rows = await queryRows(source, state)

    expect(rows).toHaveLength(1)
    expect(rows[0].page).toBe('https://example.com/blog/123')
  })

  it('engine source can run builder queries across stored tables', async () => {
    const engine = await setupEngine(dir)
    await seed(engine, [
      {
        table: 'pages',
        date: '2026-04-10',
        rows: [
          { url: '/a', date: '2026-04-10', clicks: 10, impressions: 100, sum_position: 200 },
        ],
      },
      {
        table: 'queries',
        date: '2026-04-10',
        rows: [
          { query: 'alpha', query_canonical: 'alpha', date: '2026-04-10', clicks: 15, impressions: 150, sum_position: 300 },
        ],
      },
    ])

    const source = createEngineQuerySource({
      engine,
      ctx: { userId: 'u1', siteId: 's1' },
    })

    const pageRows = await queryRows(source, gsc.select(page).where(between(date, '2026-04-10', '2026-04-10')).getState())
    const keywordRows = await queryRows(source, gsc.select(query).where(between(date, '2026-04-10', '2026-04-10')).getState())

    expect(pageRows[0].page).toBe('/a')
    expect(keywordRows[0].query).toBe('alpha')
  })

  it('movers analyzer dispatches against in-memory sources via runAnalyzerFromSource', async () => {
    const source = createInMemoryQuerySource({
      queryRows(state) {
        if (state.dimensions.includes('query')) {
          if (String(state.filter?._filters?.[0]?.expression ?? '').startsWith('2026-04-10')) {
            return [
              { query: 'alpha', page: '/a', clicks: 10, impressions: 100, ctr: 0.1, position: 3 },
            ]
          }
          return [
            { query: 'alpha', page: '/a', clicks: 2, impressions: 40, ctr: 0.05, position: 6 },
          ]
        }
        return []
      },
    })

    const out = await runAnalyzerFromSource(
      source,
      {
        type: 'movers',
        startDate: '2026-04-10',
        endDate: '2026-04-10',
        prevStartDate: '2026-04-01',
        prevEndDate: '2026-04-01',
      } as never,
      defaultAnalyzerRegistry,
    )

    expect(out.results).toHaveLength(1)
    expect((out.results as Array<{ keyword: string }>)[0].keyword).toBe('alpha')
    expect((out.meta as { rising: number }).rising).toBe(1)
    expect(moversAnalyzer.id).toBe('movers')
  })
})
