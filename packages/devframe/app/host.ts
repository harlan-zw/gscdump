import type { GscdumpContext, PageLocation, PageStats, PageStatsInput } from '../src/shared/protocol'

/** What the panel needs from where it runs: a devframe dock or the browser extension. */
export interface PanelHost {
  /** The Site to read. `pageUrl` is the page in view; the extension picks the Site by its host. */
  context: (preferredSiteId: string | null, pageUrl: string | null) => Promise<GscdumpContext>
  pageStats: (input: PageStatsInput) => Promise<PageStats>
  /** Follows the page in view and returns a stop function. `null` when the panel cannot see a page. */
  followPage: ((onPage: (location: PageLocation) => void) => () => void) | null
  /** The follow button's label, for example `Follow app`. */
  followLabel: string
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
