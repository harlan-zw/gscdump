#!/usr/bin/env node
import { defineCommand, runMain } from 'citty'
import { indexingCommand } from './commands/indexing'
import { registerCommand } from './commands/register'
import { sitemapsCommand } from './commands/sitemaps'
import { syncCommand } from './commands/sync'
import { unregisterCommand } from './commands/unregister'

const main = defineCommand({
  meta: {
    name: 'gscdump-cloud',
    description: 'Cloud CLI for gscdump.com (frozen).',
  },
  subCommands: {
    register: registerCommand,
    unregister: unregisterCommand,
    sync: syncCommand,
    indexing: indexingCommand,
    sitemaps: sitemapsCommand,
  },
})

runMain(main)
