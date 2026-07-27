import type { Row, TenantCtx } from '@gscdump/contracts'
import type { CompleteSitemapGeneration, CreateSitemapStoreOptions, ParsedUrl, SitemapDeltaFile, SitemapEventSeed, SitemapGenerationCheckpoint, SitemapHistoryDoc, SitemapIndex, SitemapPendingGeneration, SitemapReconcileGenerationCheckpoint, SitemapSiteGenerationCheckpoint, SitemapSnapshotGenerationCheckpoint, SitemapStore, SitemapUrlRecord, SnapshotUrlsResult } from './sitemap-shared'
import { encodeJsonBigintSafe } from '@gscdump/lakehouse/bigint'
import { decodeParquetToRows, encodeRowsToParquetFlex } from '../adapters/hyparquet'
import { readOptional } from '../adapters/read-optional'
import { hashSortedUrlList, hashUrl, hashUrlList, parseSitemapUrlsDeltaKey, sitemapHistoryKey, sitemapIndexKey, sitemapUrlsDeltaKey, sitemapUrlsEventKey, sitemapUrlsEventSeedKey, sitemapUrlsGenerationKey, sitemapUrlsIndexKey, sitemapUrlsIndexPrefix, sitemapUrlsPendingGenerationKey, sitemapUrlsPendingGenerationsPrefix, sitemapUrlsPrefix, sitemapUrlsProjectionManifestKey, sitemapUrlsReconcileGenerationKey } from '../entity-keys'
import { mapEntityIo } from './io'
import { createSitemapReadStore } from './sitemap'
import { decodeSitemapProjectionManifest, emptySitemapProjectionManifest, selectSitemapProjectionFiles, SITEMAP_PROJECTION_GRACE_MS, withSitemapProjectionFeed } from './sitemap-projection'
import {
  applySitemapDeltaFiles,
  createSitemapUrlState,
  readSitemapDeltaFiles,
  SITEMAP_URLS_PENDING_GENERATION_RE,
  urlRecordToRow,
  URLS_DELTA_COLUMNS,
  URLS_EVENT_COLUMNS,
  URLS_INDEX_COLUMNS,
} from './sitemap-shared'

export function createSitemapStore(opts: CreateSitemapStoreOptions): SitemapStore {
  const ds = opts.dataSource
  const hash = opts.hash ?? hashUrl
  const now = opts.now ?? (() => Date.now())
  const withMutation = opts.withMutation
  const readStore = createSitemapReadStore({ dataSource: ds, hash })

  async function readJson<T>(key: string): Promise<T | undefined> {
    const bytes = await readOptional(ds, key)
    return bytes === undefined
      ? undefined
      : JSON.parse(new TextDecoder().decode(bytes)) as T
  }

  function writeJson(key: string, value: unknown): Promise<void> {
    return ds.write(key, encodeJsonBigintSafe(value))
  }

  async function readProjectionManifest(ctx: TenantCtx): Promise<ReturnType<typeof emptySitemapProjectionManifest>> {
    const bytes = await readOptional(ds, sitemapUrlsProjectionManifestKey(ctx))
    return bytes
      ? decodeSitemapProjectionManifest(new TextDecoder().decode(bytes))
      : emptySitemapProjectionManifest()
  }

  async function deleteExpiredProjectionDeltas(
    manifest: ReturnType<typeof emptySitemapProjectionManifest>,
    deltaKeys: readonly string[],
    currentTime: number,
  ): Promise<void> {
    const expired = deltaKeys.filter((key) => {
      const parsed = parseSitemapUrlsDeltaKey(key)
      const feed = parsed ? manifest.feeds[parsed.feedpathHash] : undefined
      return Boolean(
        feed
        && key <= feed.compactedThrough
        && currentTime - feed.publishedAt >= SITEMAP_PROJECTION_GRACE_MS,
      )
    })
    if (expired.length > 0)
      await ds.delete(expired)
  }

  async function publishCurrentProjection(
    ctx: TenantCtx,
    feedpathHash: string,
    rows: readonly SitemapUrlRecord[],
    consumedDeltas: readonly SitemapDeltaFile[],
    manifest: ReturnType<typeof emptySitemapProjectionManifest>,
    publishedAt: number,
  ): Promise<ReturnType<typeof emptySitemapProjectionManifest>> {
    const bytes = encodeRowsToParquetFlex(rows.map(urlRecordToRow), {
      columns: URLS_INDEX_COLUMNS,
      sortKey: ['feedpath_hash', 'url_hash'],
    })
    await ds.write(sitemapUrlsIndexKey(ctx, feedpathHash), bytes)
    const compactedThrough = consumedDeltas.at(-1)?.key
    if (!compactedThrough)
      return manifest
    const next = withSitemapProjectionFeed(manifest, feedpathHash, {
      compactedThrough,
      publishedAt,
    })
    await writeJson(sitemapUrlsProjectionManifestKey(ctx), next)
    return next
  }

  function normalizedEventRows(rows: readonly Row[]): unknown[] {
    return rows
      .map(row => ({
        feedpath: String(row.feedpath),
        feedpathHash: String(row.feedpath_hash),
        urlHash: String(row.url_hash),
        op: String(row.op),
        loc: String(row.loc),
        lastmod: row.lastmod == null ? null : String(row.lastmod),
        generationId: String(row.generation_id),
        observedAt: Number(row.observed_at),
        sequence: Number(row.sequence),
        projectsState: Boolean(row.projects_state),
        seedGeneration: Boolean(row.seed_generation),
        generationKind: String(row.generation_kind),
        contentHash: row.content_hash == null ? null : String(row.content_hash),
        inputCount: row.input_count == null ? null : Number(row.input_count),
      }))
      .sort((a, b) =>
        a.observedAt - b.observedAt
        || a.sequence - b.sequence
        || a.urlHash.localeCompare(b.urlHash)
        || a.op.localeCompare(b.op),
      )
  }

  function eventDigest(rows: readonly Row[]): string {
    return hashUrl(JSON.stringify(normalizedEventRows(rows)))
  }

  function assertGenerationAccepted(
    generation: CompleteSitemapGeneration,
    checkpoint: { generationId: string, observedAt: number } | undefined,
    scope: string,
  ): 'newer' | 'same' {
    if (!checkpoint)
      return 'newer'
    if (generation.id === checkpoint.generationId) {
      if (generation.observedAt === checkpoint.observedAt)
        return 'same'
      throw new Error(`sitemap generation conflict for ${scope}: generation ${generation.id} changed observedAt`)
    }
    if (generation.observedAt > checkpoint.observedAt)
      return 'newer'
    const reason = generation.observedAt === checkpoint.observedAt ? 'ambiguous timestamp' : 'stale generation'
    throw new Error(`sitemap generation conflict for ${scope}: ${reason}`)
  }

  async function ensureEvents(
    ctx: TenantCtx,
    feedpathHash: string,
    generation: CompleteSitemapGeneration,
    rows: readonly Row[],
  ): Promise<{ rows: Row[], digest: string }> {
    const expectedDigest = eventDigest(rows)
    if (rows.length === 0)
      return { rows: [], digest: expectedDigest }
    const key = sitemapUrlsEventKey(ctx, feedpathHash, generation)
    await writeJson(sitemapUrlsPendingGenerationKey(ctx, feedpathHash), {
      version: 1,
      generationId: generation.id,
      observedAt: generation.observedAt,
      eventKey: key,
      eventDigest: expectedDigest,
    } satisfies SitemapPendingGeneration)
    const existing = await readOptional(ds, key)
    if (existing) {
      const existingRows = await decodeParquetToRows(existing)
      const existingDigest = eventDigest(existingRows)
      if (existingDigest !== expectedDigest)
        throw new Error(`sitemap generation conflict for ${feedpathHash}: immutable event digest changed`)
      return { rows: existingRows, digest: existingDigest }
    }
    const bytes = encodeRowsToParquetFlex(rows, {
      columns: URLS_EVENT_COLUMNS,
      sortKey: ['sequence', 'url_hash'],
    })
    await ds.write(key, bytes)
    return { rows: [...rows], digest: expectedDigest }
  }

  function eventRow(
    generation: CompleteSitemapGeneration,
    row: Row,
    metadata: {
      sequence: number
      projectsState: boolean
      seedGeneration: boolean
      generationKind: 'snapshot' | 'reconcile'
      contentHash?: string
      inputCount?: number
    },
  ): Row {
    return {
      feedpath: row.feedpath,
      feedpath_hash: row.feedpath_hash,
      url_hash: row.url_hash,
      op: row.op,
      loc: row.loc,
      lastmod: row.lastmod,
      generation_id: generation.id,
      observed_at: generation.observedAt,
      sequence: metadata.sequence,
      projects_state: metadata.projectsState ? 1 : 0,
      seed_generation: metadata.seedGeneration ? 1 : 0,
      generation_kind: metadata.generationKind,
      content_hash: metadata.contentHash ?? null,
      input_count: metadata.inputCount ?? null,
    }
  }

  function stateRowsFromEvents(rows: readonly Row[]): Row[] {
    return rows
      .filter(row => Boolean(row.projects_state))
      .map((row): Row => ({
        feedpath: row.feedpath,
        feedpath_hash: row.feedpath_hash,
        url_hash: row.url_hash,
        op: row.op,
        loc: row.loc,
        lastmod: row.lastmod,
        at: row.observed_at,
        generation_id: row.generation_id,
      }))
  }

  function checkpointFromEvents(rows: readonly Row[], digest: string): SitemapGenerationCheckpoint {
    const first = rows[0]
    if (!first)
      throw new Error('cannot checkpoint an empty sitemap event file')
    const generationId = String(first.generation_id)
    const observedAt = Number(first.observed_at)
    for (const row of rows) {
      if (String(row.generation_id) !== generationId || Number(row.observed_at) !== observedAt)
        throw new Error('sitemap event file contains multiple generations')
    }
    if (String(first.generation_kind) === 'snapshot') {
      const contentHash = String(first.content_hash)
      const inputCount = Number(first.input_count)
      const stateRows = stateRowsFromEvents(rows)
      const added = stateRows.filter(row => String(row.op) === 'added').length
      const removed = stateRows.filter(row => String(row.op) === 'removed').length
      return {
        _tag: 'snapshot',
        version: 1,
        generationId,
        observedAt,
        eventDigest: digest,
        result: {
          added,
          removed,
          kept: Math.max(0, inputCount - added),
          contentHash,
          unchanged: stateRows.length === 0,
        },
      }
    }
    return {
      _tag: 'reconcile',
      version: 1,
      generationId,
      observedAt,
      eventDigest: digest,
    }
  }

  async function projectEvents(
    ctx: TenantCtx,
    feedpathHash: string,
    rows: readonly Row[],
    digest: string,
  ): Promise<SitemapGenerationCheckpoint> {
    const checkpoint = checkpointFromEvents(rows, digest)
    const generation = { id: checkpoint.generationId, observedAt: checkpoint.observedAt }
    const stateRows = stateRowsFromEvents(rows)
    if (stateRows.length > 0) {
      const bytes = encodeRowsToParquetFlex(stateRows, {
        columns: URLS_DELTA_COLUMNS,
        sortKey: ['url_hash'],
      })
      await ds.write(sitemapUrlsDeltaKey(ctx, feedpathHash, generation), bytes)
    }
    if (rows.some(row => Boolean(row.seed_generation))) {
      await writeJson(sitemapUrlsEventSeedKey(ctx, feedpathHash), {
        version: 1,
        generationId: checkpoint.generationId,
        observedAt: checkpoint.observedAt,
      } satisfies SitemapEventSeed)
    }
    await writeJson(sitemapUrlsGenerationKey(ctx, feedpathHash), checkpoint)
    return checkpoint
  }

  async function repairFeedProjection(
    ctx: TenantCtx,
    feedpathHash: string,
  ): Promise<SitemapGenerationCheckpoint | undefined> {
    const pendingKey = sitemapUrlsPendingGenerationKey(ctx, feedpathHash)
    const [checkpoint, pending] = await Promise.all([
      readJson<SitemapGenerationCheckpoint>(sitemapUrlsGenerationKey(ctx, feedpathHash)),
      readJson<SitemapPendingGeneration>(pendingKey),
    ])
    if (!pending)
      return checkpoint
    const pendingGeneration: CompleteSitemapGeneration = {
      _tag: 'complete',
      id: pending.generationId,
      observedAt: pending.observedAt,
    }
    if (checkpoint?.generationId === pending.generationId && checkpoint.observedAt !== pending.observedAt)
      throw new Error(`sitemap generation conflict for ${feedpathHash}: generation ${pending.generationId} changed observedAt`)
    if (checkpoint && pending.observedAt < checkpoint.observedAt) {
      await ds.delete([pendingKey])
      return checkpoint
    }
    const position = assertGenerationAccepted(pendingGeneration, checkpoint, feedpathHash)
    const eventBytes = await readOptional(ds, pending.eventKey)
    if (!eventBytes) {
      await ds.delete([pendingKey])
      return checkpoint
    }
    const rows = await decodeParquetToRows(eventBytes)
    const digest = eventDigest(rows)
    if (digest !== pending.eventDigest)
      throw new Error(`sitemap generation conflict for ${feedpathHash}: pending event digest changed`)
    if (position === 'same') {
      if (checkpoint?.eventDigest !== digest)
        throw new Error(`sitemap generation conflict for ${feedpathHash}: checkpoint digest changed`)
      await ds.delete([pendingKey])
      return checkpoint
    }
    const repaired = await projectEvents(ctx, feedpathHash, rows, digest)
    await ds.delete([pendingKey])
    return repaired
  }

  return {
    ...readStore,

    writeSnapshot(ctx, records) {
      return withMutation(ctx, async () => {
        if (records.length === 0)
          return
        const indexKey = sitemapIndexKey(ctx)
        const index = (await readJson<SitemapIndex>(indexKey)) ?? { version: 1, records: {} }
        const stamp = now()
        const historyDocs = new Map<string, SitemapHistoryDoc>()
        for (const record of records) {
          const feedpathHash = hash(record.path)
          index.records[feedpathHash] = record
          historyDocs.set(sitemapHistoryKey(ctx, feedpathHash, stamp), {
            version: 1,
            path: record.path,
            capturedAt: record.capturedAt,
            record,
          })
        }
        await mapEntityIo([...historyDocs], ([key, doc]) => writeJson(key, doc))
        await writeJson(indexKey, index)
      })
    },

    snapshotUrls(ctx, generation, feedpath, urls) {
      return withMutation(ctx, async () => {
        const feedpathHash = hash(feedpath)
        const contentHash = hashUrlList(urls)
        const checkpoint = await repairFeedProjection(ctx, feedpathHash)
        const feedPosition = assertGenerationAccepted(generation, checkpoint, feedpathHash)
        if (feedPosition === 'same') {
          if (checkpoint?._tag !== 'snapshot' || checkpoint.result.contentHash !== contentHash)
            throw new Error(`sitemap generation conflict for ${feedpathHash}: snapshot input changed`)
          return checkpoint.result
        }
        const siteCheckpoint = await readJson<SitemapSiteGenerationCheckpoint>(sitemapUrlsReconcileGenerationKey(ctx))
        const sitePosition = assertGenerationAccepted(generation, siteCheckpoint, 'site reconciliation')
        if (sitePosition === 'same')
          throw new Error('sitemap generation conflict: site generation was already reconciled')
        const priorByHash = new Map<string, SitemapUrlRecord>()
        for await (const record of readStore.loadUrls(ctx, feedpath, { includeRemoved: true }))
          priorByHash.set(record.urlHash, record)
        const livePrior = [...priorByHash.values()].filter(record => record.removedAt == null)
        const incomingByHash = new Map<string, ParsedUrl>()
        for (const url of urls)
          incomingByHash.set(hash(url.loc), url)

        const deltaRows: Row[] = []
        let added = 0
        let removed = 0
        let kept = 0
        for (const [urlHash, url] of incomingByHash) {
          const previous = priorByHash.get(urlHash)
          if (!previous || previous.removedAt != null) {
            added++
            deltaRows.push({
              feedpath,
              feedpath_hash: feedpathHash,
              url_hash: urlHash,
              op: 'added',
              loc: url.loc,
              lastmod: url.lastmod ?? null,
              at: generation.observedAt,
              generation_id: generation.id,
            })
          }
          else {
            kept++
          }
        }
        for (const [urlHash, previous] of priorByHash) {
          if (previous.removedAt == null && !incomingByHash.has(urlHash)) {
            removed++
            deltaRows.push({
              feedpath,
              feedpath_hash: feedpathHash,
              url_hash: urlHash,
              op: 'removed',
              loc: previous.loc,
              lastmod: previous.lastmod ?? null,
              at: generation.observedAt,
              generation_id: generation.id,
            })
          }
        }

        const seedKey = sitemapUrlsEventSeedKey(ctx, feedpathHash)
        const seed = await readJson<SitemapEventSeed>(seedKey)
        const isSeedGeneration = seed === undefined || seed.generationId === generation.id
        const seedRows: Row[] = isSeedGeneration
          ? livePrior.map(record => ({
              feedpath,
              feedpath_hash: feedpathHash,
              url_hash: record.urlHash,
              op: 'added',
              loc: record.loc,
              lastmod: record.lastmod ?? null,
            }))
          : []
        const actualSequence = seedRows.length > 0 ? 1 : 0
        const inputCount = incomingByHash.size
        const proposedEvents = [
          ...seedRows.map(row => eventRow(generation, row, {
            sequence: 0,
            projectsState: false,
            seedGeneration: isSeedGeneration,
            generationKind: 'snapshot',
            contentHash,
            inputCount,
          })),
          ...deltaRows.map(row => eventRow(generation, row, {
            sequence: actualSequence,
            projectsState: true,
            seedGeneration: isSeedGeneration,
            generationKind: 'snapshot',
            contentHash,
            inputCount,
          })),
        ]
        const persistedEvents = await ensureEvents(ctx, feedpathHash, generation, proposedEvents)
        const result: SnapshotUrlsResult = {
          added,
          removed,
          kept,
          contentHash,
          unchanged: deltaRows.length === 0,
        }
        if (persistedEvents.rows.length > 0) {
          const projected = await projectEvents(ctx, feedpathHash, persistedEvents.rows, persistedEvents.digest)
          if (projected._tag !== 'snapshot')
            throw new Error(`sitemap generation conflict for ${feedpathHash}: expected snapshot event`)
          await ds.delete([sitemapUrlsPendingGenerationKey(ctx, feedpathHash)])
        }
        else {
          if (isSeedGeneration) {
            await writeJson(seedKey, {
              version: 1,
              generationId: generation.id,
              observedAt: generation.observedAt,
            } satisfies SitemapEventSeed)
          }
          await writeJson(sitemapUrlsGenerationKey(ctx, feedpathHash), {
            _tag: 'snapshot',
            version: 1,
            generationId: generation.id,
            observedAt: generation.observedAt,
            eventDigest: persistedEvents.digest,
            result,
          } satisfies SitemapSnapshotGenerationCheckpoint)
        }
        return result
      })
    },

    compactUrls(ctx, compactOpts = {}) {
      return withMutation(ctx, async () => {
        const startedAt = now()
        const deadlineMs = compactOpts.deadlineMs ?? Number.POSITIVE_INFINITY
        const maxFeedpaths = compactOpts.maxFeedpaths ?? Number.POSITIVE_INFINITY
        for (const key of await ds.list(`${sitemapUrlsPendingGenerationsPrefix(ctx)}/`)) {
          const feedpathHash = SITEMAP_URLS_PENDING_GENERATION_RE.exec(key)?.[1]
          if (feedpathHash)
            await repairFeedProjection(ctx, feedpathHash)
        }
        const deltaKeys = await ds.list(`${sitemapUrlsPrefix(ctx)}/deltas/`)
        let projectionManifest = await readProjectionManifest(ctx)
        await deleteExpiredProjectionDeltas(projectionManifest, deltaKeys, startedAt)
        const activeDeltaKeys = selectSitemapProjectionFiles([], deltaKeys, projectionManifest).deltaKeys
        const deltasByFeed = new Map<string, string[]>()
        for (const key of activeDeltaKeys) {
          const feedpathHash = parseSitemapUrlsDeltaKey(key)?.feedpathHash
          if (!feedpathHash)
            continue
          const keys = deltasByFeed.get(feedpathHash) ?? []
          keys.push(key)
          deltasByFeed.set(feedpathHash, keys)
        }

        const totalFeedpaths = deltasByFeed.size
        let compactedFeedpaths = 0
        for (const [feedpathHash, feedDeltaKeys] of deltasByFeed) {
          if (compactedFeedpaths > 0 && (compactedFeedpaths >= maxFeedpaths || now() - startedAt >= deadlineMs))
            break
          const [indexRows, deltaFiles] = await Promise.all([
            readOptional(ds, sitemapUrlsIndexKey(ctx, feedpathHash)).then(bytes => bytes ? decodeParquetToRows(bytes) : []),
            readSitemapDeltaFiles(ds, feedDeltaKeys),
          ])
          const state = createSitemapUrlState(indexRows)
          applySitemapDeltaFiles(state, deltaFiles)
          const merged = [...state.live.values(), ...state.removed.values()]
            .sort((a, b) => a.urlHash.localeCompare(b.urlHash))
          projectionManifest = await publishCurrentProjection(
            ctx,
            feedpathHash,
            merged,
            deltaFiles,
            projectionManifest,
            now(),
          )
          compactedFeedpaths++
        }
        return { compactedFeedpaths, remainingFeedpaths: totalFeedpaths - compactedFeedpaths }
      })
    },

    reconcile(ctx, generation, { liveFeedpaths }) {
      return withMutation(ctx, async () => {
        const liveHashes = new Set(liveFeedpaths.map(feedpath => hash(feedpath)))
        const inputDigest = hashSortedUrlList([...liveHashes])
        const siteCheckpoint = await readJson<SitemapSiteGenerationCheckpoint>(sitemapUrlsReconcileGenerationKey(ctx))
        const sitePosition = assertGenerationAccepted(generation, siteCheckpoint, 'site reconciliation')
        if (sitePosition === 'same') {
          if (siteCheckpoint?.inputDigest !== inputDigest)
            throw new Error('sitemap generation conflict: reconcile input changed')
          return { feedpathsPruned: 0, urlsRemoved: 0 }
        }

        const pendingFeedHashes = new Set<string>()
        for (const key of await ds.list(`${sitemapUrlsPendingGenerationsPrefix(ctx)}/`)) {
          const feedpathHash = SITEMAP_URLS_PENDING_GENERATION_RE.exec(key)?.[1]
          if (feedpathHash)
            pendingFeedHashes.add(feedpathHash)
        }
        const repairedCheckpoints = new Map<string, SitemapGenerationCheckpoint | undefined>()
        for (const feedpathHash of pendingFeedHashes) {
          repairedCheckpoints.set(
            feedpathHash,
            await repairFeedProjection(ctx, feedpathHash),
          )
        }

        const present = new Set<string>()
        const [indexKeys, deltaKeys] = await Promise.all([
          ds.list(`${sitemapUrlsIndexPrefix(ctx)}/`),
          ds.list(`${sitemapUrlsPrefix(ctx)}/deltas/`),
        ])
        let projectionManifest = await readProjectionManifest(ctx)
        await deleteExpiredProjectionDeltas(projectionManifest, deltaKeys, now())
        for (const feedpathHash of Object.keys(projectionManifest.feeds))
          present.add(feedpathHash)
        for (const key of indexKeys) {
          const match = /\/by-feed\/([0-9a-f]+)\/index\.parquet$/.exec(key)
          if (match?.[1])
            present.add(match[1])
        }
        const deltasByFeed = new Map<string, string[]>()
        const activeDeltaKeys = selectSitemapProjectionFiles([], deltaKeys, projectionManifest).deltaKeys
        for (const key of activeDeltaKeys) {
          const feedpathHash = parseSitemapUrlsDeltaKey(key)?.feedpathHash
          if (!feedpathHash)
            continue
          present.add(feedpathHash)
          const keys = deltasByFeed.get(feedpathHash) ?? []
          keys.push(key)
          deltasByFeed.set(feedpathHash, keys)
        }

        let feedpathsPruned = 0
        let urlsRemoved = 0
        for (const feedpathHash of present) {
          if (liveHashes.has(feedpathHash))
            continue
          const checkpoint = repairedCheckpoints.has(feedpathHash)
            ? repairedCheckpoints.get(feedpathHash)
            : await repairFeedProjection(ctx, feedpathHash)
          const feedPosition = assertGenerationAccepted(generation, checkpoint, feedpathHash)
          if (feedPosition === 'same' && checkpoint?._tag !== 'reconcile')
            throw new Error(`sitemap generation conflict for ${feedpathHash}: expected reconcile event`)
          const [indexRows, deltaFiles] = await Promise.all([
            readOptional(ds, sitemapUrlsIndexKey(ctx, feedpathHash)).then(bytes => bytes ? decodeParquetToRows(bytes) : []),
            readSitemapDeltaFiles(ds, deltasByFeed.get(feedpathHash) ?? []),
          ])
          const state = createSitemapUrlState(indexRows)
          applySitemapDeltaFiles(state, deltaFiles)
          const live = [...state.live.values()]
          const seedKey = sitemapUrlsEventSeedKey(ctx, feedpathHash)
          const seed = await readJson<SitemapEventSeed>(seedKey)
          const isSeedGeneration = seed === undefined || seed.generationId === generation.id
          const seedRows: Row[] = isSeedGeneration
            ? live.map(record => ({
                feedpath: record.feedpath,
                feedpath_hash: feedpathHash,
                url_hash: record.urlHash,
                op: 'added',
                loc: record.loc,
                lastmod: record.lastmod ?? null,
              }))
            : []
          const removalRows: Row[] = live.map(record => ({
            feedpath: record.feedpath,
            feedpath_hash: feedpathHash,
            url_hash: record.urlHash,
            op: 'removed',
            loc: record.loc,
            lastmod: record.lastmod ?? null,
          }))
          const proposedEvents = feedPosition === 'newer'
            ? [
                ...seedRows.map(row => eventRow(generation, row, {
                  sequence: 0,
                  projectsState: false,
                  seedGeneration: isSeedGeneration,
                  generationKind: 'reconcile',
                })),
                ...removalRows.map(row => eventRow(generation, row, {
                  sequence: seedRows.length > 0 ? 1 : 0,
                  projectsState: true,
                  seedGeneration: isSeedGeneration,
                  generationKind: 'reconcile',
                })),
              ]
            : []
          const persistedEvents = feedPosition === 'newer'
            ? await ensureEvents(ctx, feedpathHash, generation, proposedEvents)
            : { rows: [] as Row[], digest: checkpoint!.eventDigest }
          if (isSeedGeneration && feedPosition === 'newer') {
            await writeJson(seedKey, {
              version: 1,
              generationId: generation.id,
              observedAt: generation.observedAt,
            } satisfies SitemapEventSeed)
          }
          const removedHashes = new Set(
            persistedEvents.rows
              .filter(row => Boolean(row.projects_state) && String(row.op) === 'removed')
              .map(row => String(row.url_hash)),
          )
          const removedBeforeFeed = urlsRemoved
          for (const record of live.filter(record => removedHashes.has(record.urlHash))) {
            state.live.delete(record.urlHash)
            state.removed.set(record.urlHash, { ...record, removedAt: generation.observedAt })
            urlsRemoved++
          }
          if (live.length > 0 || deltaFiles.length > 0) {
            const merged = [...state.live.values(), ...state.removed.values()]
              .sort((a, b) => a.urlHash.localeCompare(b.urlHash))
            projectionManifest = await publishCurrentProjection(
              ctx,
              feedpathHash,
              merged,
              deltaFiles,
              projectionManifest,
              now(),
            )
          }
          if (feedPosition === 'newer') {
            const feedCheckpoint: SitemapReconcileGenerationCheckpoint = persistedEvents.rows.length > 0
              ? checkpointFromEvents(persistedEvents.rows, persistedEvents.digest) as SitemapReconcileGenerationCheckpoint
              : {
                  _tag: 'reconcile',
                  version: 1,
                  generationId: generation.id,
                  observedAt: generation.observedAt,
                  eventDigest: persistedEvents.digest,
                }
            await writeJson(sitemapUrlsGenerationKey(ctx, feedpathHash), feedCheckpoint)
            if (persistedEvents.rows.length > 0)
              await ds.delete([sitemapUrlsPendingGenerationKey(ctx, feedpathHash)])
          }
          if (urlsRemoved > removedBeforeFeed)
            feedpathsPruned++
        }
        await writeJson(sitemapUrlsReconcileGenerationKey(ctx), {
          version: 1,
          generationId: generation.id,
          observedAt: generation.observedAt,
          inputDigest,
        } satisfies SitemapSiteGenerationCheckpoint)
        return { feedpathsPruned, urlsRemoved }
      })
    },
  }
}
