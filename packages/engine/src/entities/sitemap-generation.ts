import type { Row, TenantCtx } from '@gscdump/contracts'
import type {
  CompleteSitemapGeneration,
  CompleteSitemapTraversal,
  CreateSitemapReadStoreOptions,
  CreateSitemapStoreOptions,
  FinalizeSitemapGenerationResult,
  IterateSitemapGenerationUrlsOptions,
  IterateSitemapGenerationUrlsResult,
  ListSitemapGenerationUrlsOptions,
  ListSitemapGenerationUrlsResult,
  ParsedUrl,
  QuerySitemapGenerationMembershipResult,
  RecordSitemapLegacyImportResult,
  SitemapGenerationFeedManifest,
  SitemapGenerationReadResult,
  SitemapLegacyImportEvidence,
  SitemapSiteGenerationManifest,
  SitemapStagedFeed,
  SitemapUrlRecord,
  StageSitemapGenerationFeedResult,
} from './sitemap-shared'
import { encodeJsonBigintSafe } from '@gscdump/lakehouse/bigint'
import { sitemapContentHash } from 'gscdump/sitemap-identity'
import { decodeParquetToRows, encodeRowsToParquetFlex } from '../adapters/hyparquet'
import { readOptional } from '../adapters/read-optional'
import {
  hashUrl,
  parseSitemapFeedIdentity,
  sitemapImmutableBaseKey,
  sitemapLegacyImportKey,
  sitemapPayloadHashV1,
  sitemapSiteGenerationManifestKey,
  sitemapSiteManifestKey,
  sitemapStagedFeedKey,
  sitemapStagedGenerationPrefix,
  sitemapUrlsEventKey,
} from '../entity-keys'
import { rowToUrlRecord, urlRecordToRow, URLS_EVENT_COLUMNS, URLS_INDEX_COLUMNS } from './sitemap-shared'

function validGeneration(
  generation: CompleteSitemapGeneration,
): { _tag: 'ok' } | { _tag: 'invalid_generation', reason: 'empty_id' | 'invalid_observed_at' } {
  if (!generation.id)
    return { _tag: 'invalid_generation', reason: 'empty_id' }
  if (!Number.isSafeInteger(generation.observedAt) || generation.observedAt < 0)
    return { _tag: 'invalid_generation', reason: 'invalid_observed_at' }
  return { _tag: 'ok' }
}

function cursorFor(
  generationId: string,
  feedpath: string | undefined,
  feedIndex: number,
  rowOffset: number,
): string {
  return `v2:${JSON.stringify({
    generationId,
    feedpath: feedpath ?? null,
    feedIndex,
    rowOffset,
  })}`
}

function parseCursor(
  generationId: string,
  feedpath: string | undefined,
  cursor: string | undefined,
): { _tag: 'ok', feedIndex: number, rowOffset: number } | { _tag: 'invalid' } {
  if (!cursor)
    return { _tag: 'ok', feedIndex: 0, rowOffset: 0 }
  if (!cursor.startsWith('v2:'))
    return { _tag: 'invalid' }
  let input: unknown
  try {
    input = JSON.parse(cursor.slice(3))
  }
  catch {
    return { _tag: 'invalid' }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return { _tag: 'invalid' }
  const parsed = input as Record<string, unknown>
  const feedIndex = parsed.feedIndex
  const rowOffset = parsed.rowOffset
  return parsed.generationId === generationId
    && parsed.feedpath === (feedpath ?? null)
    && typeof feedIndex === 'number'
    && Number.isSafeInteger(feedIndex)
    && feedIndex >= 0
    && typeof rowOffset === 'number'
    && Number.isSafeInteger(rowOffset)
    && rowOffset >= 0
    ? { _tag: 'ok', feedIndex, rowOffset }
    : { _tag: 'invalid' }
}

function generationPosition(
  generation: CompleteSitemapGeneration,
  current: SitemapSiteGenerationManifest | undefined,
): 'newer' | 'same' | 'stale' | 'reused' {
  if (!current)
    return 'newer'
  if (generation.id === current.generationId)
    return generation.observedAt === current.observedAt ? 'same' : 'reused'
  return generation.observedAt > current.observedAt ? 'newer' : 'stale'
}

function generationConflict(
  position: 'stale' | 'reused',
): { _tag: 'conflict', reason: 'stale_generation' | 'generation_reused' } {
  return {
    _tag: 'conflict',
    reason: position === 'stale' ? 'stale_generation' : 'generation_reused',
  }
}

function invalidStagedFeed(key: string): never {
  throw new Error(`invalid staged sitemap feed descriptor: ${key}`)
}

function parseStagedFeed(
  ctx: TenantCtx,
  generation: CompleteSitemapGeneration,
  key: string,
  input: unknown,
): SitemapStagedFeed {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return invalidStagedFeed(key)
  const staged = input as Record<string, unknown>
  if (!staged.feed || typeof staged.feed !== 'object' || Array.isArray(staged.feed))
    return invalidStagedFeed(key)
  const feed = staged.feed as Record<string, unknown>
  if (
    staged.version !== 1
    || staged.generationId !== generation.id
    || staged.observedAt !== generation.observedAt
    || typeof feed.feedpath !== 'string'
    || typeof feed.feedpathHash !== 'string'
    || typeof feed.baseKey !== 'string'
    || !(feed.eventKey === null || typeof feed.eventKey === 'string')
    || typeof feed.membershipHash !== 'string'
    || typeof feed.payloadHash !== 'string'
    || typeof feed.urlCount !== 'number'
    || !Number.isSafeInteger(feed.urlCount)
    || feed.urlCount < 0
    || feed.observedAt !== generation.observedAt
  ) {
    return invalidStagedFeed(key)
  }
  const identity = parseSitemapFeedIdentity(feed.feedpath)
  if (identity._tag !== 'ok' || identity.url !== feed.feedpath)
    return invalidStagedFeed(key)
  const expectedFeedpathHash = hashUrl(feed.feedpath)
  if (
    feed.feedpathHash !== expectedFeedpathHash
    || key !== sitemapStagedFeedKey(ctx, generation, expectedFeedpathHash)
    || feed.baseKey !== sitemapImmutableBaseKey(ctx, generation, expectedFeedpathHash)
    || (
      feed.eventKey !== null
      && feed.eventKey !== sitemapUrlsEventKey(ctx, expectedFeedpathHash, generation)
    )
  ) {
    return invalidStagedFeed(key)
  }
  return input as SitemapStagedFeed
}

interface SitemapGenerationReadMethods {
  getSitemapGeneration: (ctx: TenantCtx, generationId?: string) => Promise<SitemapGenerationReadResult>
  iterateSitemapGenerationUrls: (
    ctx: TenantCtx,
    opts?: IterateSitemapGenerationUrlsOptions,
  ) => Promise<IterateSitemapGenerationUrlsResult>
  listSitemapGenerationUrls: (
    ctx: TenantCtx,
    opts?: ListSitemapGenerationUrlsOptions,
  ) => Promise<ListSitemapGenerationUrlsResult>
  querySitemapGenerationMembership: (
    ctx: TenantCtx,
    opts: { generationId?: string, urls: readonly string[] },
  ) => Promise<QuerySitemapGenerationMembershipResult>
}

interface SitemapGenerationWriteMethods {
  stageSitemapGenerationFeed: (
    ctx: TenantCtx,
    generation: CompleteSitemapGeneration,
    feedpath: string,
    urls: readonly ParsedUrl[],
  ) => Promise<StageSitemapGenerationFeedResult>
  finalizeSitemapGeneration: (
    ctx: TenantCtx,
    generation: CompleteSitemapGeneration,
    traversal: CompleteSitemapTraversal,
  ) => Promise<FinalizeSitemapGenerationResult>
  abortSitemapGeneration: (ctx: TenantCtx, generation: CompleteSitemapGeneration) => Promise<void>
  recordSitemapLegacyImport: (
    ctx: TenantCtx,
    input: { importedAt: number, recordCount: number },
  ) => Promise<RecordSitemapLegacyImportResult>
}

export function createSitemapGenerationReadMethods(
  opts: CreateSitemapReadStoreOptions,
): SitemapGenerationReadMethods {
  const ds = opts.dataSource

  async function readJson<T>(key: string): Promise<T | undefined> {
    const bytes = await readOptional(ds, key)
    return bytes === undefined ? undefined : JSON.parse(new TextDecoder().decode(bytes)) as T
  }

  async function findManifest(
    ctx: TenantCtx,
    generationId?: string,
  ): Promise<SitemapSiteGenerationManifest | undefined> {
    const current = await readJson<SitemapSiteGenerationManifest>(sitemapSiteManifestKey(ctx))
    if (!generationId || current?.generationId === generationId)
      return current
    // Only manifests reachable from the mutable publication point are
    // published. An immutable manifest written before a crashed final switch
    // must remain invisible.
    let cursor = current
    const seen = new Set<string>()
    while (cursor?.previousManifestKey) {
      if (seen.has(cursor.previousManifestKey))
        throw new Error('sitemap generation manifest ancestry cycle')
      seen.add(cursor.previousManifestKey)
      const previous = await readJson<SitemapSiteGenerationManifest>(cursor.previousManifestKey)
      if (!previous || previous.generationId !== cursor.previousGenerationId)
        throw new Error('sitemap generation manifest ancestry is incomplete')
      if (previous.generationId === generationId)
        return previous
      cursor = previous
    }
    return undefined
  }

  async function loadFeedRows(feed: SitemapGenerationFeedManifest): Promise<SitemapUrlRecord[]> {
    const bytes = await readOptional(ds, feed.baseKey)
    if (!bytes)
      throw new Error(`published sitemap base missing: ${feed.baseKey}`)
    return (await decodeParquetToRows(bytes))
      .map((row) => {
        const record = rowToUrlRecord(row)
        return { ...record, lastSeenAt: Math.max(record.lastSeenAt, feed.observedAt) }
      })
      .sort((left, right) =>
        compareExactText(left.loc, right.loc)
        || compareExactText(left.urlHash, right.urlHash),
      )
  }

  function compareExactText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0
  }

  function selectFeeds(
    manifest: SitemapSiteGenerationManifest,
    feedpath?: string,
  ): SitemapGenerationFeedManifest[] {
    return Object.values(manifest.feeds)
      .filter(feed => !feedpath || feed.feedpath === feedpath)
      .sort((left, right) => compareExactText(left.feedpath, right.feedpath))
  }

  return {
    async getSitemapGeneration(ctx, generationId) {
      const manifest = await findManifest(ctx, generationId)
      if (manifest)
        return { _tag: 'available', manifest }
      return {
        _tag: 'unavailable',
        reason: generationId ? 'generation_not_found' : 'no_generation',
      }
    },

    async iterateSitemapGenerationUrls(ctx, iterateOpts = {}) {
      const selectionInput = iterateOpts.feedpath
        ? parseSitemapFeedIdentity(iterateOpts.feedpath)
        : undefined
      if (selectionInput && selectionInput._tag !== 'ok')
        return { _tag: 'invalid_request', reason: 'invalid_feed' }
      const manifest = await findManifest(ctx, iterateOpts.generationId)
      if (!manifest) {
        return {
          _tag: 'unavailable',
          reason: iterateOpts.generationId ? 'generation_not_found' : 'no_generation',
        }
      }
      const feeds = selectFeeds(manifest, selectionInput?.url)
      async function* items(): AsyncIterable<SitemapUrlRecord> {
        for (const feed of feeds) {
          for (const record of await loadFeedRows(feed))
            yield record
        }
      }
      return {
        _tag: 'iterator',
        generationId: manifest.generationId,
        observedAt: manifest.observedAt,
        items: items(),
        completeness: manifest.completeness,
        membershipHistoryAvailableFrom: manifest.membershipHistoryAvailableFrom,
      }
    },

    async listSitemapGenerationUrls(ctx, listOpts = {}) {
      const limit = listOpts.limit ?? 500
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
        return { _tag: 'invalid_request', reason: 'invalid_limit' }
      const selectionInput = listOpts.feedpath
        ? parseSitemapFeedIdentity(listOpts.feedpath)
        : undefined
      if (selectionInput && selectionInput._tag !== 'ok')
        return { _tag: 'invalid_request', reason: 'invalid_feed' }
      const manifest = await findManifest(ctx, listOpts.generationId)
      if (!manifest) {
        return {
          _tag: 'unavailable',
          reason: listOpts.generationId ? 'generation_not_found' : 'no_generation',
        }
      }
      const selection = selectionInput?.url
      const cursor = parseCursor(manifest.generationId, selection, listOpts.cursor)
      if (cursor._tag === 'invalid')
        return { _tag: 'invalid_request', reason: 'invalid_cursor' }
      const feeds = selectFeeds(manifest, selectionInput?.url)
      if (cursor.feedIndex > feeds.length)
        return { _tag: 'invalid_request', reason: 'invalid_cursor' }
      const items: SitemapUrlRecord[] = []
      let feedIndex = cursor.feedIndex
      let rowOffset = cursor.rowOffset
      while (feedIndex < feeds.length && items.length < limit) {
        const rows = await loadFeedRows(feeds[feedIndex]!)
        if (rowOffset > rows.length)
          return { _tag: 'invalid_request', reason: 'invalid_cursor' }
        const take = rows.slice(rowOffset, rowOffset + limit - items.length)
        items.push(...take)
        rowOffset += take.length
        if (rowOffset >= rows.length) {
          feedIndex++
          rowOffset = 0
        }
      }
      return {
        _tag: 'page',
        generationId: manifest.generationId,
        observedAt: manifest.observedAt,
        items,
        nextCursor: feedIndex < feeds.length
          ? cursorFor(manifest.generationId, selection, feedIndex, rowOffset)
          : null,
        completeness: manifest.completeness,
        membershipHistoryAvailableFrom: manifest.membershipHistoryAvailableFrom,
      }
    },

    async querySitemapGenerationMembership(ctx, queryOpts) {
      const manifest = await findManifest(ctx, queryOpts.generationId)
      if (!manifest) {
        return {
          _tag: 'unavailable',
          reason: queryOpts.generationId ? 'generation_not_found' : 'no_generation',
        }
      }
      const requested = new Set(queryOpts.urls)
      const matched = new Map<string, SitemapUrlRecord>()
      const feeds = Object.values(manifest.feeds).sort((a, b) => a.feedpath.localeCompare(b.feedpath))
      for (const feed of feeds) {
        for (const record of await loadFeedRows(feed)) {
          if (requested.has(record.loc) && !matched.has(record.loc))
            matched.set(record.loc, record)
        }
        if (matched.size === requested.size)
          break
      }
      return {
        _tag: 'result',
        generationId: manifest.generationId,
        observedAt: manifest.observedAt,
        evidence: queryOpts.urls.map((url) => {
          const record = matched.get(url)
          return record
            ? {
                _tag: 'present' as const,
                url,
                feedpath: record.feedpath,
                lastmod: record.lastmod ?? null,
                firstSeenAt: record.firstSeenAt,
                lastSeenAt: record.lastSeenAt,
              }
            : { _tag: 'absent' as const, url, observedAt: manifest.observedAt }
        }),
        completeness: manifest.completeness,
        membershipHistoryAvailableFrom: manifest.membershipHistoryAvailableFrom,
      }
    },
  }
}

export function createSitemapGenerationWriteMethods(
  opts: CreateSitemapStoreOptions,
): SitemapGenerationWriteMethods {
  const ds = opts.dataSource
  const now = opts.now ?? (() => Date.now())

  async function readJson<T>(key: string): Promise<T | undefined> {
    const bytes = await readOptional(ds, key)
    return bytes === undefined ? undefined : JSON.parse(new TextDecoder().decode(bytes)) as T
  }

  function writeJson(key: string, value: unknown): Promise<void> {
    return ds.write(key, encodeJsonBigintSafe(value))
  }

  function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    return left.length === right.length && left.every((byte, index) => byte === right[index])
  }

  async function writeImmutable(key: string, bytes: Uint8Array, label: string): Promise<void> {
    const existing = await readOptional(ds, key)
    if (!existing) {
      await ds.write(key, bytes)
      return
    }
    if (!bytesEqual(existing, bytes))
      throw new Error(`sitemap immutable ${label} conflict: ${key}`)
  }

  async function currentManifest(ctx: TenantCtx): Promise<SitemapSiteGenerationManifest | undefined> {
    return readJson<SitemapSiteGenerationManifest>(sitemapSiteManifestKey(ctx))
  }

  async function objectExists(key: string): Promise<boolean> {
    if (ds.head)
      return (await ds.head(key)) !== undefined
    return (await readOptional(ds, key)) !== undefined
  }

  async function generationIsPublished(
    ctx: TenantCtx,
    generation: CompleteSitemapGeneration,
  ): Promise<boolean> {
    let cursor = await currentManifest(ctx)
    const seen = new Set<string>()
    while (cursor) {
      if (
        cursor.generationId === generation.id
        && cursor.observedAt === generation.observedAt
      ) {
        return true
      }
      if (cursor.observedAt < generation.observedAt || !cursor.previousManifestKey)
        return false
      if (seen.has(cursor.previousManifestKey))
        throw new Error('sitemap generation manifest ancestry cycle')
      seen.add(cursor.previousManifestKey)
      const previous = await readJson<SitemapSiteGenerationManifest>(cursor.previousManifestKey)
      if (!previous || previous.generationId !== cursor.previousGenerationId)
        throw new Error('sitemap generation manifest ancestry is incomplete')
      cursor = previous
    }
    return false
  }

  async function readFeedRows(feed: SitemapGenerationFeedManifest | undefined): Promise<SitemapUrlRecord[]> {
    if (!feed)
      return []
    const bytes = await readOptional(ds, feed.baseKey)
    if (!bytes)
      throw new Error(`published sitemap base missing: ${feed.baseKey}`)
    return (await decodeParquetToRows(bytes)).map(rowToUrlRecord)
  }

  function eventRows(
    generation: CompleteSitemapGeneration,
    feedpath: string,
    feedpathHash: string,
    previous: readonly SitemapUrlRecord[],
    next: readonly SitemapUrlRecord[],
  ): Row[] {
    const previousByLoc = new Map(previous.map(record => [record.loc, record]))
    const nextByLoc = new Map(next.map(record => [record.loc, record]))
    const changed: Array<{
      op: 'added' | 'removed' | 'updated'
      record: SitemapUrlRecord
      previousLastmod?: string
    }> = []
    for (const record of next) {
      const prior = previousByLoc.get(record.loc)
      if (!prior)
        changed.push({ op: 'added', record })
      else if ((prior.lastmod ?? null) !== (record.lastmod ?? null))
        changed.push({ op: 'updated', record, previousLastmod: prior.lastmod })
    }
    for (const record of previous) {
      if (!nextByLoc.has(record.loc))
        changed.push({ op: 'removed', record })
    }
    return changed
      .sort((a, b) => a.record.loc.localeCompare(b.record.loc) || a.op.localeCompare(b.op))
      .map(({ op, record, previousLastmod }, sequence): Row => ({
        feedpath,
        feedpath_hash: feedpathHash,
        url_hash: record.urlHash,
        op,
        loc: record.loc,
        lastmod: record.lastmod ?? null,
        previous_lastmod: previousLastmod ?? null,
        generation_id: generation.id,
        observed_at: generation.observedAt,
        sequence,
        projects_state: 1,
      }))
  }

  async function writeImmutableEvents(
    ctx: TenantCtx,
    generation: CompleteSitemapGeneration,
    feedpath: string,
    feedpathHash: string,
    rows: readonly Row[],
  ): Promise<string | null> {
    if (rows.length === 0)
      return null
    const key = sitemapUrlsEventKey(ctx, feedpathHash, generation)
    const bytes = encodeRowsToParquetFlex(rows, {
      columns: URLS_EVENT_COLUMNS,
      sortKey: ['sequence', 'url_hash'],
    })
    await writeImmutable(key, bytes, `event for ${feedpath}`)
    return key
  }

  return {
    stageSitemapGenerationFeed(ctx, generation, inputFeedpath, urls) {
      return opts.withMutation(ctx, async () => {
        const valid = validGeneration(generation)
        if (valid._tag !== 'ok')
          return valid
        const identity = parseSitemapFeedIdentity(inputFeedpath)
        if (identity._tag !== 'ok')
          return { _tag: 'invalid_feed', reason: identity.reason }
        const feedpath = identity.url
        const feedpathHash = hashUrl(feedpath)
        const current = await currentManifest(ctx)
        const position = generationPosition(generation, current)
        if (position === 'stale' || position === 'reused')
          return generationConflict(position)

        const incomingByLoc = new Map<string, ParsedUrl>()
        for (const url of urls)
          incomingByLoc.set(url.loc, url)
        const canonicalUrls = [...incomingByLoc.values()]
        const stagedKey = sitemapStagedFeedKey(ctx, generation, feedpathHash)
        const existingInput = await readJson<unknown>(stagedKey)
        const existing = existingInput === undefined
          ? undefined
          : parseStagedFeed(ctx, generation, stagedKey, existingInput)
        const membershipHash = await sitemapContentHash(canonicalUrls)
        const payloadHash = sitemapPayloadHashV1(canonicalUrls)
        const previousFeed = current?.feeds[feedpathHash]
        const previousRows = await readFeedRows(previousFeed)
        const previousByLoc = new Map(previousRows.map(record => [record.loc, record]))
        const nextRows = [...incomingByLoc]
          .map(([loc, url]): SitemapUrlRecord => {
            const prior = previousByLoc.get(loc)
            return {
              feedpath,
              feedpathHash,
              urlHash: hashUrl(`sitemap-url:v1\u0000${loc}`),
              loc,
              lastmod: url.lastmod,
              firstSeenAt: prior?.firstSeenAt ?? generation.observedAt,
              lastSeenAt: generation.observedAt,
            }
          })
          .sort((a, b) => a.loc.localeCompare(b.loc))
        const changes = eventRows(generation, feedpath, feedpathHash, previousRows, nextRows)
        const baseKey = sitemapImmutableBaseKey(ctx, generation, feedpathHash)
        const eventKey = changes.length === 0
          ? null
          : sitemapUrlsEventKey(ctx, feedpathHash, generation)
        const feed: SitemapGenerationFeedManifest = {
          feedpath,
          feedpathHash,
          baseKey,
          eventKey,
          membershipHash,
          payloadHash,
          urlCount: nextRows.length,
          observedAt: generation.observedAt,
        }
        if (
          existing
          && (
            existing.feed.feedpath !== feedpath
            || existing.feed.membershipHash !== membershipHash
            || existing.feed.payloadHash !== payloadHash
            || existing.feed.eventKey !== eventKey
            || existing.feed.urlCount !== nextRows.length
          )
        ) {
          return { _tag: 'conflict', reason: 'generation_reused' }
        }
        // The descriptor is a write-ahead cleanup record. A crash from this
        // point onward leaves abort enough exact information to delete every
        // generation-owned immutable object without a broad prefix sweep.
        if (!existing) {
          await writeJson(stagedKey, {
            version: 1,
            generationId: generation.id,
            observedAt: generation.observedAt,
            feed,
          } satisfies SitemapStagedFeed)
        }
        await writeImmutable(baseKey, encodeRowsToParquetFlex(nextRows.map(urlRecordToRow), {
          columns: URLS_INDEX_COLUMNS,
          sortKey: ['feedpath_hash', 'url_hash'],
        }), `base for ${feedpath}`)
        await writeImmutableEvents(ctx, generation, feedpath, feedpathHash, changes)
        return {
          _tag: 'staged',
          generationId: generation.id,
          feedpath,
          membershipChanged: previousFeed?.membershipHash !== membershipHash,
          payloadChanged: previousFeed?.payloadHash !== payloadHash,
          added: changes.filter(row => row.op === 'added').length,
          removed: changes.filter(row => row.op === 'removed').length,
          updated: changes.filter(row => row.op === 'updated').length,
        }
      })
    },

    finalizeSitemapGeneration(ctx, generation, traversal) {
      return opts.withMutation(ctx, async () => {
        const valid = validGeneration(generation)
        if (valid._tag !== 'ok')
          return valid
        const current = await currentManifest(ctx)
        const position = generationPosition(generation, current)
        if (position === 'stale' || position === 'reused')
          return generationConflict(position)
        if (position === 'same') {
          return {
            _tag: 'unchanged',
            generationId: generation.id,
            observedAt: generation.observedAt,
            feedCount: Object.keys(current?.feeds ?? {}).length,
          }
        }

        const expected = new Map<string, string>()
        const invalidFeedpaths: string[] = []
        for (const raw of traversal.expectedFeedpaths) {
          const identity = parseSitemapFeedIdentity(raw)
          if (identity._tag !== 'ok') {
            invalidFeedpaths.push(raw)
            continue
          }
          expected.set(hashUrl(identity.url), identity.url)
        }
        const feeds: Record<string, SitemapGenerationFeedManifest> = {}
        const missingFeedpaths: string[] = []
        for (const [feedpathHash, feedpath] of expected) {
          const stagedKey = sitemapStagedFeedKey(ctx, generation, feedpathHash)
          const stagedInput = await readJson<unknown>(stagedKey)
          const staged = stagedInput === undefined
            ? undefined
            : parseStagedFeed(ctx, generation, stagedKey, stagedInput)
          const stagedObjectsExist = staged
            ? await Promise.all([
                objectExists(staged.feed.baseKey),
                ...(staged.feed.eventKey ? [objectExists(staged.feed.eventKey)] : []),
              ]).then(results => results.every(Boolean))
            : false
          if (
            !staged
            || !stagedObjectsExist
            || staged.generationId !== generation.id
            || staged.observedAt !== generation.observedAt
            || staged.feed.feedpath !== feedpath
          ) {
            missingFeedpaths.push(feedpath)
            continue
          }
          feeds[feedpathHash] = staged.feed
        }
        if (missingFeedpaths.length > 0 || invalidFeedpaths.length > 0)
          return { _tag: 'incomplete', missingFeedpaths, invalidFeedpaths }

        const eventKeys = Object.values(feeds)
          .map(feed => feed.eventKey)
          .filter((key): key is string => key !== null)
        for (const [feedpathHash, priorFeed] of Object.entries(current?.feeds ?? {})) {
          if (feeds[feedpathHash])
            continue
          const previousRows = await readFeedRows(priorFeed)
          const eventKey = await writeImmutableEvents(
            ctx,
            generation,
            priorFeed.feedpath,
            feedpathHash,
            eventRows(generation, priorFeed.feedpath, feedpathHash, previousRows, []),
          )
          if (eventKey)
            eventKeys.push(eventKey)
        }
        const legacyImport = (await readJson<SitemapLegacyImportEvidence>(sitemapLegacyImportKey(ctx)))
          ?? { _tag: 'none' }
        const manifestKey = sitemapSiteGenerationManifestKey(ctx, generation)
        const existingManifest = await readJson<SitemapSiteGenerationManifest>(manifestKey)
        const manifest: SitemapSiteGenerationManifest = {
          version: 1,
          generationId: generation.id,
          observedAt: generation.observedAt,
          publishedAt: existingManifest?.publishedAt ?? now(),
          completeness: { _tag: 'complete' },
          membershipHistoryAvailableFrom: current?.membershipHistoryAvailableFrom ?? generation.observedAt,
          legacyImport,
          previousGenerationId: current?.generationId ?? null,
          previousManifestKey: current
            ? sitemapSiteGenerationManifestKey(ctx, {
                id: current.generationId,
                observedAt: current.observedAt,
              })
            : null,
          eventKeys: eventKeys.sort(),
          feeds,
        }
        await writeImmutable(
          manifestKey,
          encodeJsonBigintSafe(manifest),
          `generation manifest for ${generation.id}`,
        )
        const latest = await currentManifest(ctx)
        if (JSON.stringify(latest) !== JSON.stringify(current)) {
          const latestPosition = generationPosition(generation, latest)
          if (latestPosition === 'same') {
            return {
              _tag: 'unchanged',
              generationId: generation.id,
              observedAt: generation.observedAt,
              feedCount: Object.keys(latest?.feeds ?? {}).length,
            }
          }
          if (latestPosition === 'stale' || latestPosition === 'reused')
            return generationConflict(latestPosition)
          return { _tag: 'conflict', reason: 'publication_changed' }
        }
        // The mutable site manifest is the only publication point. Everything
        // it references is immutable and already durable.
        await writeJson(sitemapSiteManifestKey(ctx), manifest)
        return {
          _tag: 'published',
          generationId: generation.id,
          observedAt: generation.observedAt,
          feedCount: Object.keys(feeds).length,
        }
      })
    },

    abortSitemapGeneration(ctx, generation) {
      return opts.withMutation(ctx, async () => {
        const valid = validGeneration(generation)
        if (valid._tag !== 'ok')
          throw new Error(`invalid sitemap generation: ${valid.reason}`)
        if (await generationIsPublished(ctx, generation))
          throw new Error(`cannot abort published sitemap generation: ${generation.id}`)

        const stagedKeys = await ds.list(`${sitemapStagedGenerationPrefix(ctx, generation)}/`)
        const stagedFeeds = await Promise.all(stagedKeys.map(async (key) => {
          const input = await readJson<unknown>(key)
          if (input === undefined)
            return invalidStagedFeed(key)
          return parseStagedFeed(ctx, generation, key, input)
        }))
        const cleanup = new Set<string>([
          ...stagedKeys,
          sitemapSiteGenerationManifestKey(ctx, generation),
        ])
        for (const staged of stagedFeeds) {
          cleanup.add(staged.feed.baseKey)
          if (staged.feed.eventKey)
            cleanup.add(staged.feed.eventKey)
        }
        // Finalize can create dropped-feed events before the immutable
        // generation manifest. Their keys are bounded by the current feed set
        // and derivable even if finalize crashed before recording references.
        const current = await currentManifest(ctx)
        for (const [feedpathHash] of Object.entries(current?.feeds ?? {}))
          cleanup.add(sitemapUrlsEventKey(ctx, feedpathHash, generation))
        await ds.delete([...cleanup])
      })
    },

    recordSitemapLegacyImport(ctx, input) {
      return opts.withMutation(ctx, async () => {
        if (!Number.isSafeInteger(input.importedAt) || input.importedAt < 0)
          return { _tag: 'invalid', reason: 'invalid_imported_at' }
        if (!Number.isSafeInteger(input.recordCount) || input.recordCount < 0)
          return { _tag: 'invalid', reason: 'invalid_record_count' }
        const key = sitemapLegacyImportKey(ctx)
        const existing = await readJson<Extract<SitemapLegacyImportEvidence, { _tag: 'metadata_only' }>>(key)
        if (existing)
          return { _tag: 'existing', evidence: existing }
        const evidence = {
          _tag: 'metadata_only' as const,
          importedAt: input.importedAt,
          recordCount: input.recordCount,
          source: 'gsc_sitemaps' as const,
        }
        await writeJson(key, evidence)
        return { _tag: 'recorded', evidence }
      })
    },
  }
}
