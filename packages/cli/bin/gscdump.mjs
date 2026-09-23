#!/usr/bin/env node

import process from 'node:process'

// Node does not flush pending pipe writes on process.exit. Drain a stream
// first so a failed run cannot truncate piped output.
function drained(stream) {
  return new Promise((resolve) => {
    stream.once('error', resolve)
    if (stream.write(''))
      resolve()
    else
      stream.once('drain', resolve)
  })
}

import ('../dist/cli.mjs').then(async ({ runCli }) => {
  const code = await runCli()
  // A failed command may leave handles open (DuckDB, sockets). Exit now.
  // On success the process ends by itself, so a server command stays up.
  if (code !== 0) {
    await Promise.all([drained(process.stdout), drained(process.stderr)])
    process.exit(code)
  }
}).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
