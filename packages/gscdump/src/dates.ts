/**
 * Lightweight date interface for GSC retention, freshness, and calendar work.
 * UTC arithmetic is named explicitly; query-relative Pacific dates remain
 * separate because Google Search Console's reporting day is America/Los_Angeles.
 */
export {
  countDays,
  DAYS_PER_RANGE,
  daysAgo as daysAgoUtc,
  generateGscDateRange,
  getBackfillProgress,
  getDateRange,
  getFreshestGscDate,
  getLatestGscDate,
  getNextDate,
  getOldestGscDate,
  getPendingDates,
  getPstDate,
  groupIntoRanges,
  GSC_FINALIZED_LAG_DAYS,
  GSC_FRESHEST_LAG_DAYS,
  GSC_RETENTION_MONTHS,
  MS_PER_DAY,
  toIsoDate,
} from './core/gsc-dates'

export { currentPstDate, daysAgoPst } from './query/utils/dayjs'
