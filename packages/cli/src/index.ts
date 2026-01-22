#!/usr/bin/env node

import process from 'node:process'
import { defineCommand, runMain } from 'citty'
// TODO: Restore once gscdump fetch* functions are re-implemented
// import { analyzeCommand } from './commands/analyze'
import { authCommand } from './commands/auth'
// import { compareCommand } from './commands/compare'
import { configCommand } from './commands/config'
// import { dumpCommand } from './commands/dump'
// import { indexingCommand, inspectCommand } from './commands/indexing'
import { initCommand } from './commands/init'
import { mcpCommand } from './commands/mcp'
import { sitemapsCommand } from './commands/sitemaps'
import { sitesCommand } from './commands/sites'
import { syncCommand } from './commands/sync'
import { showSplash, VERSION } from './utils'

const main = defineCommand({
  meta: {
    name: 'gscdump',
    version: VERSION,
    description: 'Google Search Console Data Extractor',
  },
  subCommands: {
    init: initCommand,
    // dump: dumpCommand, // TODO: restore
    sync: syncCommand,
    // compare: compareCommand, // TODO: restore
    // analyze: analyzeCommand, // TODO: restore
    sites: sitesCommand,
    sitemaps: sitemapsCommand,
    // index: indexingCommand, // TODO: restore
    // inspect: inspectCommand, // TODO: restore
    auth: authCommand,
    config: configCommand,
    mcp: mcpCommand,
  },
  setup() {
    // Skip splash for MCP mode - stdout is used for protocol
    if (!process.argv.includes('mcp')) {
      showSplash()
    }
  },
})

runMain(main)
