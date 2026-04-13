#!/usr/bin/env node

import process from 'node:process'
import { defineCommand, runMain } from 'citty'
import { analysisCommand } from './commands/analysis'
import { authCommand } from './commands/auth'
import { compactCommand } from './commands/compact'
import { configCommand } from './commands/config'
import { dumpCommand } from './commands/dump'
import { indexingCommand } from './commands/indexing'
import { initCommand } from './commands/init'
import { mcpCommand } from './commands/mcp'
import { queryCommand } from './commands/query'
import { registerCommand } from './commands/register'
import { sitemapsCommand } from './commands/sitemaps'
import { sitesCommand } from './commands/sites'
import { statsCommand } from './commands/stats'
import { syncCommand } from './commands/sync'
import { unregisterCommand } from './commands/unregister'
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
    register: registerCommand,
    unregister: unregisterCommand,
    sync: syncCommand,
    stats: statsCommand,
    compact: compactCommand,
    indexing: indexingCommand,
    analysis: analysisCommand,
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
