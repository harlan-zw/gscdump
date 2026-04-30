import process from 'node:process'
import { confirm, isCancel } from '@clack/prompts'
import { defineCommand } from 'citty'
import { createCommandContext } from '../context'
import { applyOutputMode, logger, OUTPUT_ARGS } from '../utils'

export const rmSiteCommand = defineCommand({
  meta: {
    name: 'rm-site',
    description: 'Delete every parquet, manifest, watermark, and sync-state record for a single site',
  },
  args: {
    site: { type: 'positional', required: true, description: 'Site URL (e.g. sc-domain:example.com)' },
    yes: { type: 'boolean', alias: 'y', default: false, description: 'Skip confirmation prompt' },
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const ctx = await createCommandContext({ needsStore: true })
    const store = ctx.store!
    const siteId = store.siteIdFor(String(args.site))

    if (!args.yes && !json) {
      const ok = await confirm({
        message: `Delete ALL local data for ${args.site}? This is irreversible.`,
        initialValue: false,
      })
      if (isCancel(ok) || !ok) {
        logger.info('Cancelled')
        process.exit(0)
      }
    }

    const result = await store.engine.purgeTenant({ userId: store.userId, siteId })

    if (json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }
    logger.success(`Removed local data for ${args.site}`)
    console.log(`  Objects deleted:    ${result.objectsDeleted}`)
    console.log(`  Manifest entries:   ${result.entriesRemoved}`)
    console.log(`  Watermarks:         ${result.watermarksRemoved}`)
    console.log(`  Sync states:        ${result.syncStatesRemoved}`)
  },
})

export const resetCommand = defineCommand({
  meta: {
    name: 'reset',
    description: 'Wipe the entire local store (every site, every table). Irreversible.',
  },
  args: {
    yes: { type: 'boolean', alias: 'y', default: false, description: 'Skip confirmation prompt' },
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const ctx = await createCommandContext({ needsStore: true })
    const store = ctx.store!

    if (!args.yes && !json) {
      const ok = await confirm({
        message: `Wipe the entire local store under ${store.dataDir}? This deletes data for ALL sites.`,
        initialValue: false,
      })
      if (isCancel(ok) || !ok) {
        logger.info('Cancelled')
        process.exit(0)
      }
    }

    const result = await store.engine.purgeTenant({ userId: store.userId })

    if (json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }
    logger.success('Local store reset')
    console.log(`  Objects deleted:    ${result.objectsDeleted}`)
    console.log(`  Manifest entries:   ${result.entriesRemoved}`)
    console.log(`  Watermarks:         ${result.watermarksRemoved}`)
    console.log(`  Sync states:        ${result.syncStatesRemoved}`)
  },
})
