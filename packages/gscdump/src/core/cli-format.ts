/**
 * Build a row with default-zeroed metrics. Callers attach dimension keys
 * separately (positional via `row.keys[i]` for the raw GSC API, or named via
 * `row[dim]` for the gscdump.com REST API).
 */
export function rowWithMetricDefaults(row: {
  clicks?: number | null
  impressions?: number | null
  ctr?: number | null
  position?: number | null
}): {
  clicks: number
  impressions: number
  ctr: number
  position: number
} {
  return {
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    ctr: row.ctr ?? 0,
    position: row.position ?? 0,
  }
}

export function progressBar(current: number, total: number, label: string, width = 30): string {
  const percent = Math.min(current / total, 1)
  const filled = Math.round(width * percent)
  const empty = width - filled
  const bar = `\x1B[36m${'█'.repeat(filled)}\x1B[0m\x1B[90m${'░'.repeat(empty)}\x1B[0m`
  return `  ${bar} \x1B[90m${current}/${total}\x1B[0m ${label}`
}
