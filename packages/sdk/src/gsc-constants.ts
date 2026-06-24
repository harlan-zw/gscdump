/**
 * Google Search Console data is considered "unstable" for this many days from
 * today (PST). Rows within the window may still shift as GSC finalizes clicks/
 * impressions; charts render those points under a dimmed / striped overlay so
 * users don't misread last-day dips as trends.
 *
 * This is the client DISPLAY-latency band, NOT the server lake-membership
 * boundary. gscdump's `DEFAULT_STABILITY_CUTOFF_DAYS` (= 4) decides which days
 * live in the Iceberg lake vs the recent overlay; this constant (= 3) only dims
 * the UI. The display band is intentionally one day SMALLER so that, even at
 * maximum UTC-vs-PST clock skew, the freshest UI-requested day is lake-resident
 * (R2-SQL-complete) rather than overlay-only. The two are distinct concepts; do
 * not unify them to a single value (gscdump plan
 * `2026-06-24-overlay-canonical-merge-unification.md` W6).
 */
export const GSC_STABLE_LATENCY_DAYS = 3
