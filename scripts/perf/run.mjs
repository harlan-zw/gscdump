import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

// Measures two revisions of the same code against each other in one process
// tree, on one machine, within seconds. Machine class, CPU model, thermal
// state, and noisy neighbours hit both sides equally, so they cancel in the
// delta. A number compared against another machine's number is not fixable by
// statistics, so this harness never compares across runs.
//
//   node scripts/perf/run.mjs --head <dist-root> --parent <dist-root> --out perf.json
//
// Each side's <dist-root> is a full checkout whose packages are already built.
// Case files always come from this revision, so both sides run identical
// measurement code against different builds.

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) {
    if (fallback === undefined)
      throw new Error(`Pass --${name}`)
    return fallback
  }
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--'))
    throw new Error(`--${name} needs a value`)
  return value
}

/**
 * Reads a true or false flag, and refuses anything else.
 *
 * A caller that passes an empty value means something went wrong on its side.
 * Reading that as false would hide the fault and store a wrong measurement, so
 * it fails here instead.
 */
function flag(name) {
  const value = argument(name, 'false')
  if (value !== 'true' && value !== 'false')
    throw new Error(`--${name} takes true or false, not ${JSON.stringify(value)}`)
  return value === 'true'
}

/** Runs one case file in a fresh process and reads its single JSON line. */
function sample(caseFile, command, root, fixtures) {
  const result = spawnSync(process.execPath, [
    '--expose-gc',
    '--max-old-space-size=2048',
    caseFile,
    command,
    '--root',
    root,
    '--fixtures',
    fixtures,
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (result.error)
    throw result.error
  if (result.status !== 0)
    throw new Error(`${caseFile} ${command} failed: ${result.stderr}`)
  const line = result.stdout.trim().split('\n').at(-1)
  const parsed = JSON.parse(line)
  if (typeof parsed.value !== 'number' || !Number.isFinite(parsed.value))
    throw new Error(`${caseFile} reported no numeric value`)
  return parsed
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function round(value) {
  return Math.round(value * 1000) / 1000
}

const headRoot = resolve(argument('head'))
const parentRoot = resolve(argument('parent'))
const outPath = resolve(argument('out', 'perf.json'))
const manifestPath = resolve(argument('manifest', 'perf/benchmarks.json'))
const only = process.argv.includes('--only') ? argument('only') : null

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const fixtures = mkdtempSync(join(tmpdir(), 'gscdump-perf-'))
const benchmarks = []

try {
  for (const benchmark of manifest.benchmarks) {
    if (only !== null && benchmark.id !== only)
      continue
    const caseFile = resolve(benchmark.case)
    // A multiple of three, so each of the three sides occupies each position
    // in the rotation the same number of times. An uneven count hands one
    // side more first places than the others, and first place is measurably
    // different from the rest.
    const repeats = benchmark.repeats ?? manifest.repeats ?? 9
    const warmups = benchmark.warmups ?? manifest.warmups ?? 2

    // Fixtures are built once, by this revision, and both sides read the same
    // bytes. A side that generated its own fixtures would measure its own
    // encoder as well as the case under test.
    if (benchmark.prepare !== false)
      sample(caseFile, 'prepare', headRoot, fixtures)

    for (let index = 0; index < warmups; index++) {
      sample(caseFile, 'sample', headRoot, fixtures)
      sample(caseFile, 'sample', parentRoot, fixtures)
    }

    // Three sides, not two. The control is the head build measured a second
    // time, so its delta against head is pure measurement noise. It answers
    // the only question that matters for a threshold: how big is a difference
    // this machine invents on its own, today, for this case?
    const sides = { head: [], parent: [], control: [] }
    const roots = { head: headRoot, parent: parentRoot, control: headRoot }
    const names = ['head', 'parent', 'control']
    const checksums = new Set()
    for (let index = 0; index < repeats; index++) {
      // Rotating the order stops one side from always paying for whatever the
      // machine does first in a group.
      for (let offset = 0; offset < names.length; offset++) {
        const name = names[(index + offset) % names.length]
        const taken = sample(caseFile, 'sample', roots[name], fixtures)
        sides[name].push(taken.value)
        checksums.add(taken.checksum ?? null)
      }
    }

    const headMin = Math.min(...sides.head)
    const parentMin = Math.min(...sides.parent)
    const controlMin = Math.min(...sides.control)
    // The minimum leads, because noise only ever adds. A count kind has no
    // noise to remove, so both statistics agree there.
    const percent = (value, against) => against === 0 ? null : round((value - against) / against * 100)
    const deltaPercent = percent(headMin, parentMin)
    const controlPercent = percent(controlMin, headMin)
    benchmarks.push({
      id: benchmark.id,
      kind: benchmark.kind,
      unit: benchmark.unit,
      repeats,
      head: { min: round(headMin), median: round(median(sides.head)) },
      parent: { min: round(parentMin), median: round(median(sides.parent)) },
      control: { min: round(controlMin), median: round(median(sides.control)) },
      deltaPercent,
      // How far the same build moved against itself in this same job. A
      // reader must clear this before it calls a delta a slowdown. One
      // control is one sample of the noise, so the rule belongs to the
      // reader, not here: this harness reports, it does not judge.
      controlPercent,
      // Both sides must agree on what they produced. A faster revision that
      // returns different bytes is a defect, never a win.
      verified: checksums.size === 1,
    })
  }
}
finally {
  rmSync(fixtures, { force: true, recursive: true })
}

const measurement = {
  harness: manifest.harness,
  commit: argument('commit', 'unknown'),
  parentCommit: argument('parent-commit', 'unknown'),
  // Each side installs from its own lockfile, so a dependency change does not
  // invalidate the comparison. It does explain one: a delta here may belong to
  // the dependency rather than to this repository's code.
  dependenciesChanged: flag('dependencies-changed'),
  runner: process.env.RUNNER_NAME === undefined ? 'local' : process.env.ImageOS ?? 'unknown',
  node: process.version,
  cpu: cpus()[0]?.model ?? 'unknown',
  measuredAt: new Date().toISOString(),
  benchmarks,
}

// The caller names a path, not a directory it has to remember to create.
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, `${JSON.stringify(measurement, null, 2)}\n`)
const signed = value => value === null ? 'n/a' : `${value > 0 ? '+' : ''}${value}%`
for (const benchmark of benchmarks) {
  const verified = benchmark.verified ? '' : '  UNVERIFIED: the sides disagree on their output'
  console.log(`${benchmark.id}  head ${benchmark.head.min} ${benchmark.unit}  parent ${benchmark.parent.min} ${benchmark.unit}  delta ${signed(benchmark.deltaPercent)}  noise ${signed(benchmark.controlPercent)}${verified}`)
}
