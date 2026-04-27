// Quota helpers for the URL Inspection API.
// Google's per-site daily limit is 2,000 inspections, reset at midnight PST.

export const INDEXING_DAILY_LIMIT = 2000

// 10% safety buffer reserved for retries / races.
export const INDEXING_EFFECTIVE_LIMIT = 1800
