import { spawnSync } from 'node:child_process'
import { cpus } from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// Build the packages first. Run the same script on both revisions:
// node packages/engine/scripts/benchmark-startup.mjs
// Each sample imports a published entry point in a fresh Node process.
// Dynamic import measures module loading without including process startup.
const entries = ['@gscdump/engine', '@gscdump/engine/hyparquet', '@gscdump/engine/schema', '@gscdump/engine/node']
if (process.argv[2] === 'sample') {
  const entry = process.argv[3]
  if (!entries.includes(entry))
    throw new Error(`Unknown benchmark entry: ${entry}`)
  globalThis.gc()
  const baselineRssMiB = process.memoryUsage().rss / 1024 ** 2
  const start = performance.now()
  await import(entry)
  const importMs = performance.now() - start
  const peakRssMiB = process.resourceUsage().maxRSS / 1024
  globalThis.gc()
  const { rss, heapUsed, heapTotal } = process.memoryUsage()
  console.log(JSON.stringify({ entry, importMs, peakRssMiB, baselineRssMiB, rssMiB: rss / 1024 ** 2, heapUsedMiB: heapUsed / 1024 ** 2, heapTotalMiB: heapTotal / 1024 ** 2 }))
}
else {
  console.log(JSON.stringify({ node: process.version, cpu: cpus()[0]?.model, samples: 7 }))
  for (const entry of entries) {
    for (let sample = 0; sample < 7; sample++) {
      const result = spawnSync(process.execPath, [
        '--expose-gc',
        '--max-old-space-size=2048',
        fileURLToPath(import.meta.url),
        'sample',
        entry,
      ], { encoding: 'utf8', maxBuffer: 1024 * 1024 })
      if (result.error)
        throw result.error
      if (result.status !== 0)
        throw new Error(`Benchmark process failed: ${result.stderr}`)
      console.log(result.stdout.trim())
    }
  }
}
