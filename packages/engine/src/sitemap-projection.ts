import { parseSitemapUrlsDeltaKey } from './entity-keys'

export const SITEMAP_PROJECTION_GRACE_MS = 15 * 60 * 1000

export interface SitemapProjectionFeed {
  compactedThrough: string
  /** Unix epoch milliseconds when readers started filtering through this key. */
  publishedAt: number
}

export interface SitemapProjectionManifest {
  version: 1
  feeds: Record<string, SitemapProjectionFeed>
}

export interface SitemapProjectionFiles {
  indexKeys: string[]
  deltaKeys: string[]
}

export function emptySitemapProjectionManifest(): SitemapProjectionManifest {
  return { version: 1, feeds: {} }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function parseSitemapProjectionManifest(value: unknown): SitemapProjectionManifest {
  const manifest = objectRecord(value)
  const rawFeeds = objectRecord(manifest?.feeds)
  if (manifest?.version !== 1 || !rawFeeds)
    throw new Error('invalid sitemap projection manifest')

  const feeds: Record<string, SitemapProjectionFeed> = {}
  for (const [feedpathHash, rawFeed] of Object.entries(rawFeeds)) {
    const feed = objectRecord(rawFeed)
    const compactedThrough = feed?.compactedThrough
    const publishedAt = feed?.publishedAt
    if (typeof compactedThrough !== 'string')
      throw new Error(`invalid sitemap projection manifest feed: ${feedpathHash}`)
    const parsedKey = parseSitemapUrlsDeltaKey(compactedThrough)
    if (
      !/^[0-9a-f]+$/.test(feedpathHash)
      || parsedKey?.feedpathHash !== feedpathHash
      || !Number.isSafeInteger(publishedAt)
      || Number(publishedAt) < 0
    ) {
      throw new Error(`invalid sitemap projection manifest feed: ${feedpathHash}`)
    }
    feeds[feedpathHash] = {
      compactedThrough,
      publishedAt: Number(publishedAt),
    }
  }
  return { version: 1, feeds }
}

export function decodeSitemapProjectionManifest(text: string): SitemapProjectionManifest {
  return parseSitemapProjectionManifest(JSON.parse(text))
}

export function selectSitemapProjectionFiles(
  indexKeys: readonly string[],
  deltaKeys: readonly string[],
  manifest: SitemapProjectionManifest | undefined,
): SitemapProjectionFiles {
  return {
    indexKeys: indexKeys.filter(key => key.endsWith('/index.parquet')),
    deltaKeys: deltaKeys.filter((key) => {
      const parsed = parseSitemapUrlsDeltaKey(key)
      if (!parsed)
        return false
      const feed = manifest?.feeds[parsed.feedpathHash]
      return !feed || key > feed.compactedThrough
    }),
  }
}

export function withSitemapProjectionFeed(
  manifest: SitemapProjectionManifest,
  feedpathHash: string,
  feed: SitemapProjectionFeed,
): SitemapProjectionManifest {
  return {
    version: 1,
    feeds: {
      ...manifest.feeds,
      [feedpathHash]: feed,
    },
  }
}
