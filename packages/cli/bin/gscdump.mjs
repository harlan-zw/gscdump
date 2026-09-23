#!/usr/bin/env node

import process from 'node:process'

import ('../dist/cli.mjs').then(async ({ runCli }) => {
  const code = await runCli()
  // A failed command may leave handles open (DuckDB, sockets). Exit now.
  // On success the process ends by itself, so a server command stays up.
  if (code !== 0)
    process.exit(code)
}).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
