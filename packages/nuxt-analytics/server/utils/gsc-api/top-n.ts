// Thin auto-import shim. Canonical helpers live at `@gscdump/analysis/source`
// (see ARCHITECTURE.md — narrowest-subpath rule) and `gscdump/tenant`. Re-
// exporting through server/utils/ keeps them auto-imported inside Nitro
// routes without forcing every endpoint to spell out the import.

import type { GoogleSearchConsoleClient } from 'gscdump'
import { googleSearchConsole } from 'gscdump'

export {
  collectGscRows as collectRows,
  fetchGscDaily,
  fetchGscTopN,
} from '@gscdump/analysis/source'
export type {
  FetchTopNOptions,
  GscDailyRow,
  GscRange,
  GscTopNRow,
} from '@gscdump/analysis/source'

export { decodeSiteId as decodeSiteIdToGscUrl } from 'gscdump/tenant'

export function gscClient(token: string): GoogleSearchConsoleClient {
  return googleSearchConsole(token)
}
