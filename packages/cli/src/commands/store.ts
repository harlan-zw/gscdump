import { defineCommand } from 'citty'
import { storeCommandMeta } from '../command-meta'
import { noSubcommandSelected } from '../utils'
import { compactCommand } from './compact'
import { gcCommand } from './gc'
import { rollupsCommand } from './rollups'
import { statsCommand } from './stats'
import { resetCommand, rmSiteCommand } from './store-purge'

export const storeCommand = defineCommand({
  meta: storeCommandMeta,
  args: statsCommand.args,
  subCommands: {
    'stats': statsCommand,
    'compact': compactCommand,
    'gc': gcCommand,
    'rollups': rollupsCommand,
    'rm-site': rmSiteCommand,
    'reset': resetCommand,
  },
  // No subcommand: show stats (read-only default).
  async run({ args }) {
    if (!noSubcommandSelected('store', ['stats', 'compact', 'gc', 'rollups', 'rm-site', 'reset']))
      return
    await statsCommand.run?.({ args, cmd: statsCommand, rawArgs: [] } as any)
  },
})
