#!/usr/bin/env node

import process from 'node:process'

import ('../dist/cli.mjs').then(({ runCli }) => runCli()).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
