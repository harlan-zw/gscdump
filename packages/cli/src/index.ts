#!/usr/bin/env node

import process from 'node:process'
import { defineCommand, runMain } from 'citty'
import { authCommand } from './commands/auth'
import { configCommand } from './commands/config'
import { dumpCommand } from './commands/dump'
import { initCommand } from './commands/init'
import { mcpCommand } from './commands/mcp'
import { queryCommand } from './commands/query'
import { sitemapsCommand } from './commands/sitemaps'
import { sitesCommand } from './commands/sites'
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
