import { z } from 'zod'

/**
 * Google's URL Inspection `coverageState`, parsed into one tag per state.
 *
 * Google reports coverage as English prose ("Crawled - currently not indexed").
 * Matching that prose with `LIKE` counted both "Crawled - currently not indexed"
 * and "Discovered - currently not indexed" as crawled. A tag names one state, so
 * a count per tag cannot blur two states. `gscdump` owns the string table that
 * maps Google's prose onto these tags (`parseCoverageState`).
 *
 * The first four tags form the coverage ladder, in order. The remaining tags are
 * exclusions Google reports beside the ladder. `unrecognized` holds prose no tag
 * maps yet, and `not_reported` holds an inspection with no coverage prose.
 */
export const COVERAGE_STATE_TAGS = [
  'unknown_to_google',
  'discovered_not_indexed',
  'crawled_not_indexed',
  'indexed',
  'noindex',
  'blocked_robots',
  'soft_404',
  'not_found',
  'server_error',
  'access_denied',
  'access_forbidden',
  'blocked_4xx',
  'redirect',
  'redirect_error',
  'alternate_canonical',
  'duplicate_no_canonical',
  'duplicate_google_canonical',
  'page_removed',
  'unrecognized',
  'not_reported',
] as const

export type CoverageStateTag = typeof COVERAGE_STATE_TAGS[number]

/**
 * The coverage ladder, lowest rung first: Google does not know the URL, Google
 * queued it without a crawl, Google crawled it and left it out, Google indexed it.
 */
export const COVERAGE_LADDER = [
  'unknown_to_google',
  'discovered_not_indexed',
  'crawled_not_indexed',
  'indexed',
] as const satisfies readonly CoverageStateTag[]

export type CoverageLadderTag = typeof COVERAGE_LADDER[number]

export const coverageStateTagSchema = z.enum(COVERAGE_STATE_TAGS)

const urlCount = z.number().int().nonnegative()

type CoverageStateCountsShape = { [K in CoverageStateTag]: z.ZodDefault<typeof urlCount> }

/**
 * One URL count per coverage state. A state with no URLs counts 0, and a tag
 * the payload leaves out parses as 0, so a newer client reads an older host's
 * counts. A tag this client does not know is kept as sent, so an older client
 * reads a newer host's counts. Neither case fails the parse.
 */
export const coverageStateCountsSchema = z.object(
  Object.fromEntries(COVERAGE_STATE_TAGS.map(tag => [tag, urlCount.default(0)])) as CoverageStateCountsShape,
).loose()

export type CoverageStateCounts = Record<CoverageStateTag, number>

/**
 * How old the stored URL Inspection verdicts behind a count are. The periods
 * are rolling, not calendar days: `olderThan7d` counts verdicts inspected more
 * than 7 times 24 hours before the capture, and `olderThan30d` more than 30
 * times 24 hours. `unmeasured` marks a count stored before gscdump recorded
 * verdict ages.
 */
export const verdictFreshnessSchema = z.discriminatedUnion('_tag', [
  z.object({
    _tag: z.literal('measured'),
    verdicts: urlCount,
    olderThan7d: urlCount,
    olderThan30d: urlCount,
    olderThan7dPercent: z.number().min(0).max(100),
    olderThan30dPercent: z.number().min(0).max(100),
  }).loose(),
  z.object({ _tag: z.literal('unmeasured') }).loose(),
])

export type VerdictFreshness = z.infer<typeof verdictFreshnessSchema>

/**
 * When gscdump counted the stored URL Inspection verdicts behind a read, and how
 * old those verdicts are. A verdict can be months older than its capture: the
 * inspection scheduler rechecks unchanged URLs less often over time.
 *
 * - `captured`: `capturedAt` is when gscdump computed the counts. `source` is
 *   `stored` for the daily counts gscdump saved or `live` for a count made during
 *   this request. `scope` is `sitemap_members` when the counts cover only URLs in
 *   the Site's live sitemaps, `inspected_urls` when sitemap membership was not
 *   available and the counts cover every inspected URL, and `unrecorded` for a
 *   summary stored before gscdump recorded its scope. `oldestVerdictAt` and
 *   `newestVerdictAt` bound the inspection times of the verdicts counted.
 * - `empty`: gscdump holds no URL Inspection verdicts for the Site.
 */
export const indexingCaptureSchema = z.discriminatedUnion('_tag', [
  z.object({
    _tag: z.literal('captured'),
    capturedAt: z.string(),
    source: z.enum(['stored', 'live']),
    scope: z.enum(['sitemap_members', 'inspected_urls', 'unrecorded']),
    oldestVerdictAt: z.string().nullable(),
    newestVerdictAt: z.string().nullable(),
    freshness: verdictFreshnessSchema,
  }).loose(),
  z.object({ _tag: z.literal('empty') }).loose(),
])

export type IndexingCapture = z.infer<typeof indexingCaptureSchema>

/**
 * The coverage-state counts gscdump stored for one day of the indexing trend.
 *
 * - `counted`: `counts` holds one URL count per coverage state, taken at
 *   `capturedAt` from the latest verdict per URL. `freshness` measures verdict
 *   age at that capture.
 * - `not_counted`: the day was stored before gscdump counted coverage states.
 */
export const coverageStatesPointSchema = z.discriminatedUnion('_tag', [
  z.object({
    _tag: z.literal('counted'),
    capturedAt: z.string(),
    counts: coverageStateCountsSchema,
    freshness: verdictFreshnessSchema,
  }).loose(),
  z.object({ _tag: z.literal('not_counted') }).loose(),
])

export type CoverageStatesPoint = z.infer<typeof coverageStatesPointSchema>

/** Most Watched URLs one Site can hold. */
export const WATCHED_URL_LIMIT = 50

/** Days between the scheduled URL Inspections of one Watched URL. */
export const WATCHED_URL_CADENCE_DAYS = 7

/** Most Checkpoints returned per Watched URL, newest first. */
export const WATCHED_URL_CHECKPOINT_LIMIT = 12

/**
 * One scheduled URL Inspection of a Watched URL. `coverageState` is the parsed
 * tag, and a tag this client does not know parses as `unrecognized`, so an older
 * client reads a newer host's Checkpoints. `googleCoverageState` is Google's
 * prose as returned.
 */
export const watchedUrlCheckpointSchema = z.object({
  checkedAt: z.string(),
  coverageState: coverageStateTagSchema.catch('unrecognized'),
  googleCoverageState: z.string().nullable(),
  verdict: z.string().nullable(),
  lastCrawlTime: z.string().nullable(),
}).loose()

export type WatchedUrlCheckpoint = z.infer<typeof watchedUrlCheckpointSchema>

export const watchedUrlSchema = z.object({
  url: z.string(),
  addedAt: z.string(),
  /** When the next scheduled inspection is due. Discovery runs daily and spends the Site's inspection budget on due Watched URLs first. */
  dueAt: z.string(),
  checkpoints: z.array(watchedUrlCheckpointSchema),
}).loose()

export type WatchedUrl = z.infer<typeof watchedUrlSchema>

export const watchedUrlsResponseSchema = z.object({
  watched: z.array(watchedUrlSchema),
  limit: z.number().int().positive(),
  cadenceDays: z.number().int().positive(),
  meta: z.object({ siteUrl: z.string() }).loose(),
}).loose()

export const watchedUrlsChangeRequestSchema = z.strictObject({
  urls: z.array(z.string().url()).min(1).max(WATCHED_URL_LIMIT),
})

export const watchedUrlSkipReasonSchema = z.enum(['domain_mismatch', 'fragment', 'limit_reached', 'inspection_disabled'])

export const watchedUrlsChangeResponseSchema = z.object({
  /** URLs this request added or removed. */
  changed: z.array(z.string()),
  /** URLs already in the requested state: watched on add, not watched on remove. */
  unchanged: z.array(z.string()),
  skipped: z.array(z.object({ url: z.string(), reason: watchedUrlSkipReasonSchema }).loose()),
  /** Watched URLs the Site holds after this request. */
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
}).loose()
