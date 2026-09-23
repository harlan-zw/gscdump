import { defineCommand } from 'citty'
import { storeCommandMeta } from '../command-meta'
import { compactCommand } from './compact'
import { exportCommand } from './export'
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
    'export': exportCommand,
    'rollups': rollupsCommand,
    'rm-site': rmSiteCommand,
    'reset': resetCommand,
  },
  // No subcommand: show stats (read-only default).
  async run({ args }) {
    await statsCommand.run?.({ args, cmd: statsCommand, rawArgs: [] } as any)
  },
})
