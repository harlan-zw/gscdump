import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

// Total built byte size of the Engine. A counter, so it carries no measurement
// noise at all: the same build always gives the same number. This is the tier
// that may one day gate a check, and it catches bundle growth that a timing
// case would never show.
function argument(name) {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? undefined : process.argv[index + 1]
  if (value === undefined)
    throw new Error(`Pass --${name}`)
  return value
}

function totalBytes(directory) {
  let total = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    total += entry.isDirectory() ? totalBytes(path) : statSync(path).size
  }
  return total
}

const command = process.argv[2]
const dist = join(argument('root'), 'packages/engine/dist')

if (command === 'prepare')
  console.log(JSON.stringify({ value: 0 }))
else if (command === 'sample')
  console.log(JSON.stringify({ value: totalBytes(dist), checksum: 'count' }))
else
  throw new Error(`Unknown command: ${command}`)
