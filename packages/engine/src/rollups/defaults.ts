import type { RollupDef } from './core'
import { queryCanonicalDailyRollup, queryCanonicalVariantsRollup } from './canonical'
import {
  indexingHealthRollup,
  indexingMetadataRollup,
  indexPercentRollup,
  sitemapChanges28dRollup,
  sitemapHealthRollup,
} from './indexing'
import {
  dailyTotalsRollup,
  topCountries28dRollup,
  topKeywords28dRollup,
  topPages28dRollup,
  weeklyTotalsRollup,
} from './traffic'

export const DEFAULT_ROLLUPS: readonly RollupDef[] = [
  dailyTotalsRollup,
  weeklyTotalsRollup,
  topPages28dRollup,
  topKeywords28dRollup,
  topCountries28dRollup,
  indexingMetadataRollup,
  indexingHealthRollup,
  indexPercentRollup,
  sitemapHealthRollup,
  sitemapChanges28dRollup,
]

/**
 * Canonical-primary rollups (ADR-0017 / ADR-0018). Opt-in — kept out of
 * `DEFAULT_ROLLUPS` because they only pay off once the consumer queries by
 * `queryCanonical` and wires the read seams (`resolveExtra` /
 * `canonicalSource`). Hosts opt in by concatenating these onto their def list
 * (CLI: `gscdump rollups --with-canonical`).
 */
export const CANONICAL_ROLLUPS: readonly RollupDef[] = [
  queryCanonicalVariantsRollup,
  queryCanonicalDailyRollup,
]
