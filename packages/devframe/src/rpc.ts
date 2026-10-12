import type { GscdumpReader } from './reader'
import type { GscdumpContext, PageStats } from './shared/protocol'
import { defineRpcFunction } from 'devframe'
import { z } from 'zod'

const pageStatsArgs = z.object({
  page: z.string().min(1).describe('A path such as `/blog/post`, or a full URL of a page on the Site.'),
  period: z.enum(['7d', '28d', '3m']).optional().describe('The window to read. Defaults to `28d`.'),
  siteId: z.string().optional().describe('The Site ID. Defaults to the Site the devtool reads.'),
})

/** Types the result for the panel. The node side builds it, so it needs no runtime check. */
const pageStatsResult = z.custom<PageStats>()

/**
 * The node side's two reads. Names are bare: the definition registers them
 * through a context scoped to the devframe id, so the wire names are
 * `gscdump:get-context` and `gscdump:get-page-stats`.
 */
export function createRpcFunctions(reader: GscdumpReader) { // eslint-disable-line ts/explicit-function-return-type -- the definitions' inferred types are the registry
  return [
    defineRpcFunction({
      name: 'get-context',
      type: 'query',
      jsonSerializable: true,
      handler: (preferredSiteId?: string | null, pageUrl?: string | null): Promise<GscdumpContext> => reader.context(preferredSiteId ?? null, pageUrl ?? null),
    }),
    defineRpcFunction({
      name: 'get-page-stats',
      type: 'query',
      args: [pageStatsArgs],
      returns: pageStatsResult,
      agent: {
        title: 'Search Console page stats',
        description: 'Read Google Search Console clicks, impressions, CTR, average position, the daily series, and the top queries for one page of the Site, from the gscdump Hosted record. Call it to check how a page performs in Google search before or after you change it.',
      },
      handler: input => reader.pageStats(input),
    }),
  ] as const
}
