import { defineCommand } from 'citty'
import { noSubcommandSelected } from '../utils'
import { compactCommand } from './compact'
import { exportCommand } from './export'
import { gcCommand } from './gc'
import { rollupsCommand } from './rollups'
import { statsCommand } from './stats'
import { resetCommand, rmSiteCommand } from './store-purge'

export const storeCommand = defineCommand({
  meta: {
    name: 'store',
    description: 'Manage the local DuckDB/Parquet store',
  },
  subCommands: {
    'stats': statsCommand,
    'compact': compactCommand,
    'gc': gcCommand,
    'export': exportCommand,
    'rollups': rollupsCommand,
    'rm-site': rmSiteCommand,
    'reset': resetCommand,
  },
  // No subcommand: show stats (read-only default).
  async run({ args }) {
    if (!noSubcommandSelected('store', ['stats', 'compact', 'gc', 'export', 'rollups', 'rm-site', 'reset']))
      return
    await statsCommand.run?.({ args, cmd: statsCommand, rawArgs: [] } as any)
  },
})
