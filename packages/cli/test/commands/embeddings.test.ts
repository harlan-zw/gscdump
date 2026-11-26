import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmbeddingProvider } from '../../src/embeddings-provider'
import { createLocalStore } from '../../src/local-store'

const mockContext = vi.hoisted(() => ({
  createCommandContext: vi.fn(),
}))

vi.mock('../../src/context', () => ({
  createCommandContext: mockContext.createCommandContext,
}))

const { analyzeCommand } = await import('../../src/commands/analyze')
const { entitiesCommand } = await import('../../src/commands/entities')

async function runSub(cmd: { run?: (ctx: { args: Record<string, unknown> }) => Promise<void> }, args: Record<string, unknown>): Promise<void> {
  await cmd.run!({ args })
}

describe('createEmbeddingProvider', () => {
  it('calls Ollama /api/embed with model and batch input', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      embeddings: [[1, 0, 0], [0, 1, 0]],
    }), { status: 200 }))

    const provider = createEmbeddingProvider({
      provider: 'ollama',
      model: 'bge-m3',
      ollamaUrl: 'http://127.0.0.1:11434/',
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
    })

    const out = await provider.embedBatch(['nyfw', 'hotel'])
    expect(out).toEqual([[1, 0, 0], [0, 1, 0]])
    expect(fetchFn).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/embed',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model: 'bge-m3', input: ['nyfw', 'hotel'] }),
      }),
    )
  })

  it('calls Cloudflare Workers AI REST API and rejects missing credentials', async () => {
    expect(() => createEmbeddingProvider({ provider: 'workers-ai' })).toThrow(/CLOUDFLARE_ACCOUNT_ID/)

    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      result: { data: [[0.5, 0.5]] },
    }), { status: 200 }))

    const provider = createEmbeddingProvider({
      provider: 'workers-ai',
      cloudflareAccountId: 'acct-123',
      cloudflareApiToken: 'tok-xyz',
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
    })

    const out = await provider.embedBatch(['nyfw'])
    expect(out).toEqual([[0.5, 0.5]])
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/acct-123/ai/run/@cf/baai/bge-m3',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer tok-xyz' }),
        body: JSON.stringify({ text: ['nyfw'] }),
      }),
    )
  })
})

describe('entities embeddings + analyze semantic-clusters CLI', () => {
  const dirs: string[] = []
  afterEach(async () => {
    vi.restoreAllMocks()
    mockContext.createCommandContext.mockReset()
    for (const d of dirs.splice(0))
      await rm(d, { recursive: true, force: true })
  })

  it('builds incremental Int8 Parquet sidecar, reports status, and runs semantic-clusters with version guards', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gscdump-emb-'))
    dirs.push(dir)

    const store = createLocalStore({ dataDir: dir })
    const siteUrl = 'https://example.com/'
    const siteId = store.siteIdFor(siteUrl)
    await store.engine.writeDay(
      { userId: store.userId, siteId, table: 'queries', date: '2026-04-10' },
      [
        { query: 'nyfw', date: '2026-04-10', clicks: 40, impressions: 800, sum_position: 2400 },
        { query: 'new york fashion week', date: '2026-04-10', clicks: 80, impressions: 1200, sum_position: 2400 },
        { query: 'nuxt 3 seo', date: '2026-04-10', clicks: 15, impressions: 300, sum_position: 600 },
        { query: 'nuxt 4 seo', date: '2026-04-10', clicks: 15, impressions: 300, sum_position: 600 },
      ],
    )

    mockContext.createCommandContext.mockResolvedValue({
      store,
      resolveSite: async () => siteUrl,
    })

    const vectorLookup: Record<string, number[]> = {
      'nyfw': [0.99, 0.14, 0, 0],
      'fashion new week york': [0.98, 0.2, 0, 0],
      '3 nuxt seo': [0, 0, 1, 0],
      '4 nuxt seo': [0, 0, 1, 0],
    }

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] }
      const embeddings = body.input.map(text => vectorLookup[text] ?? [0, 0, 0, 1])
      return new Response(JSON.stringify({ embeddings }), { status: 200 })
    })

    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      logs.push(String(msg ?? ''))
    })

    const embeddingsCmd = (entitiesCommand.subCommands as Record<string, any>).embeddings
    const buildCmd = embeddingsCmd.subCommands.build
    const statusCmd = embeddingsCmd.subCommands.status
    const semanticCmd = (analyzeCommand.subCommands as Record<string, any>)['semantic-clusters']

    // 1. Initial build embeds all 4 canonicals.
    await runSub(buildCmd, { 'site': siteUrl, 'provider': 'ollama', 'model': 'embeddinggemma:300m', 'min-impressions': '10', 'json': true })
    const build1 = JSON.parse(logs.at(-1)!)
    expect(build1).toMatchObject({
      model: 'embeddinggemma:300m',
      dims: 4,
      newlyEmbedded: 4,
      reused: 0,
      totalStored: 4,
      quantization: 'int8-symmetric',
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // 2. Re-run is incremental: 0 new embeddings fetched.
    await runSub(buildCmd, { 'site': siteUrl, 'provider': 'ollama', 'model': 'embeddinggemma:300m', 'min-impressions': '10', 'json': true })
    const build2 = JSON.parse(logs.at(-1)!)
    expect(build2).toMatchObject({ newlyEmbedded: 0, reused: 4, totalStored: 4 })
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // 3. Status reflects persisted metadata.
    await runSub(statusCmd, { site: siteUrl, json: true })
    const status = JSON.parse(logs.at(-1)!)
    expect(status).toMatchObject({
      exists: true,
      meta: { model: 'embeddinggemma:300m', dims: 4, rowCount: 4, quantization: 'int8-symmetric' },
    })

    // 4. `analyze semantic-clusters` clusters `nyfw` + `new york fashion week`, keeps `nuxt 3` vs `nuxt 4` apart.
    await runSub(semanticCmd, {
      'site': siteUrl,
      'start': '2026-04-10',
      'end': '2026-04-10',
      'min-impressions': '10',
      'threshold': '0.86',
      'json': true,
    })
    const clustered = JSON.parse(logs.at(-1)!)
    expect(clustered.results).toHaveLength(1)
    expect(clustered.results[0]).toMatchObject({
      label: 'new york fashion week',
      keywordCount: 2,
      totalImpressions: 2000,
    })
    expect(clustered.meta).toMatchObject({
      algorithm: 'upgma',
      model: 'embeddinggemma:300m',
      threshold: 0.86,
      embeddedQueries: 4,
      missingEmbeddings: 0,
      unclusteredQueries: 2,
    })
  }, 30_000)
})
