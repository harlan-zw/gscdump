#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// Renders one measurement as the pull request comment.
//
// The gate is measured, not assumed. Every benchmark carries the delta the
// same build produced against itself in the same job, so a reading counts only
// when it beats that noise by a margin. A count benchmark has no noise at all,
// so any movement there is real.
const TIME_FLOOR_PERCENT = 5
const NOISE_MARGIN = 2

function formatBytes(bytes) {
  const absolute = Math.abs(bytes)
  if (absolute >= 1024 * 1024)
    return `${(bytes / 1024 ** 2).toFixed(2)} MiB`
  if (absolute >= 1024)
    return `${(bytes / 1024).toFixed(1)} KiB`
  return `${bytes} B`
}

function formatValue(benchmark, value) {
  if (benchmark.unit === 'bytes')
    return formatBytes(value)
  if (benchmark.unit === 'ms')
    return `${value.toFixed(2)} ms`
  return `${value} ${benchmark.unit}`
}

function formatPercent(percent) {
  if (percent === null)
    return '—'
  return `${percent > 0 ? '+' : ''}${percent.toFixed(2)}%`
}

function escapeCell(value) {
  return String(value).replaceAll('|', '&#124;').replace(/[\r\n]+/g, ' ')
}

/** The delta a benchmark must beat before anyone calls it a change. */
function gatePercent(benchmark) {
  if (benchmark.kind === 'count')
    return 0
  const noise = Math.abs(benchmark.controlPercent ?? 0) * NOISE_MARGIN
  return Math.max(TIME_FLOOR_PERCENT, noise)
}

function classify(benchmark) {
  const delta = benchmark.deltaPercent
  if (delta === null || !benchmark.verified)
    return { ...benchmark, _tag: 'Unusable' }
  const gate = gatePercent(benchmark)
  if (Math.abs(delta) <= gate)
    return { ...benchmark, _tag: 'Unchanged', gate }
  return { ...benchmark, _tag: delta > 0 ? 'Slower' : 'Faster', gate }
}

function subject(row) {
  const amount = formatValue(row, Math.abs(row.head.min - row.parent.min))
  return `\`${escapeCell(row.id)}\` ${row._tag === 'Slower' ? 'grew' : 'fell'} by ${amount} (${formatPercent(Math.abs(row.deltaPercent))})`
}

function renderOutcome(rows) {
  const unusable = rows.filter(row => row._tag === 'Unusable')
  const slower = rows.filter(row => row._tag === 'Slower')
  const faster = rows.filter(row => row._tag === 'Faster')
  if (unusable.length)
    return `⚠️ **${unusable.length} benchmark${unusable.length === 1 ? '' : 's'} produced no usable reading.** The two sides disagreed on their output, or the case failed.`
  if (slower.length === 1 && faster.length === 0)
    return `🔴 **${subject(slower[0])}.**`
  if (faster.length === 1 && slower.length === 0)
    return `🟢 **${subject(faster[0])}.**`
  if (slower.length)
    return `⚠️ **${slower.length} slower and ${faster.length} faster, past the noise this run measured.**`
  if (faster.length)
    return `🟢 **${faster.length} benchmark${faster.length === 1 ? '' : 's'} improved past the noise this run measured.**`
  return '✅ **No clear performance change.**'
}

function renderTable(rows) {
  const output = [
    '| Benchmark | Base | This PR | Change | Noise |',
    '|---|---:|---:|---:|---:|',
  ]
  for (const row of rows) {
    const mark = row._tag === 'Slower' ? '🔴 ' : row._tag === 'Faster' ? '🟢 ' : ''
    const change = row._tag === 'Unusable' ? '—' : `${mark}${formatPercent(row.deltaPercent)}`
    output.push(`| \`${escapeCell(row.id)}\` | ${formatValue(row, row.parent.min)} | ${formatValue(row, row.head.min)} | ${change} | ${formatPercent(row.controlPercent)} |`)
  }
  return output
}

function renderHowToRead(rows) {
  const counts = rows.filter(row => row.kind === 'count').length
  return [
    '<details><summary>How to read this</summary>',
    '',
    'Both revisions are built and measured in one job, on one machine, alternating within seconds. Machine class, CPU model, and noisy neighbours hit both sides equally, so they cancel in the change column.',
    '',
    '**Noise** is this run marking its own homework. It is the same build measured a second time against itself, so it should be zero and never is. A change counts only when it clears twice the noise, or 5%, whichever is larger.',
    '',
    counts > 0
      ? `A \`count\` benchmark carries no noise at all, so any movement there is real. ${counts} of ${rows.length} here ${counts === 1 ? 'is' : 'are'} a count.`
      : 'Every benchmark here is timed, so every reading carries noise.',
    '',
    'Values are the fastest of the repeats. The minimum leads, because noise only ever adds.',
    '',
    '</details>',
  ]
}

export function renderReport(measurement, baseLabel = '') {
  const rows = (measurement.benchmarks ?? []).map(benchmark => classify(benchmark))
  const output = ['### ⚡ Perf', '', renderOutcome(rows), '']
  if (rows.length)
    output.push(...renderTable(rows), '', ...renderHowToRead(rows))
  else
    output.push('No benchmark produced a reading.')
  if (measurement.paired === false)
    output.push('', '> ⚠️ This pull request changes `pnpm-lock.yaml`. Both sides build from one lockfile, so this comparison is not valid.')
  if (baseLabel)
    output.push('', `<sub>Base: ${escapeCell(baseLabel)}. Both sides ran on the same runner, ${measurement.repeats ?? rows[0]?.repeats ?? 'several'} repeats each.</sub>`)
  return `${output.join('\n')}\n`
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const path = process.env.MEASUREMENT
  if (!path || !existsSync(path))
    throw new TypeError('MEASUREMENT must point to a measurement produced by scripts/perf/run.mjs.')
  process.stdout.write(renderReport(JSON.parse(readFileSync(path, 'utf8')), process.env.BASE_LABEL))
}
