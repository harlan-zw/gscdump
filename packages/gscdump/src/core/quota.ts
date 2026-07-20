// Quota helpers for the URL Inspection API.
// Google's per-site daily limit is 2,000 inspections, reset at midnight PST.

// 10% safety buffer under Google's 2,000/day limit, reserved for retries / races.
export const URL_INSPECTION_EFFECTIVE_LIMIT = 1800
