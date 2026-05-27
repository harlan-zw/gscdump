/**
 * Google Search Console data is considered "unstable" for this many days from
 * today (PST). Rows within the window may still shift as GSC finalizes clicks/
 * impressions; charts render those points under a dimmed / striped overlay so
 * users don't misread last-day dips as trends.
 */
export const GSC_STABLE_LATENCY_DAYS = 3
