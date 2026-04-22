#!/usr/bin/env node

import process from 'node:process'
import { defineCommand, runMain } from 'citty'
import { analyzeCommand } from './commands/analyze'
import { authCommand } from './commands/auth'
import { configCommand } from './commands/config'
import { dumpCommand } from './commands/dump'
import { entitiesCommand } from './commands/entities'
import { initCommand } from './commands/init'
import { inspectCommand } from './commands/inspect'
import { mcpCommand } from './commands/mcp'
import { queryCommand } from './commands/query'
import { sitemapsCommand } from './commands/sitemaps'
import { sitesCommand } from './commands/sites'
import { storeCommand } from './commands/store'
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
    dump: dumpCommand,
    query: queryCommand,
    sites: sitesCommand,
    sitemaps: sitemapsCommand,
    sync: syncCommand,
    store: storeCommand,
    inspect: inspectCommand,
    entities: entitiesCommand,
    analyze: analyzeCommand,
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
