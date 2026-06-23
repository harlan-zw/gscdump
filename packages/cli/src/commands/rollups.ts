import type { TableName } from '../local-store'
import {
  classifyQueryIntent,
  encodeIntent,
  INTENT_CLASSIFIER_VERSION,
  normalizeQuery,
  NORMALIZER_VERSION,
} from '@gscdump/analysis'
import { buildQueryDimRecords, createQueryDimStore } from '@gscdump/engine/entities'
import { CANONICAL_ROLLUPS, DEFAULT_ROLLUPS, rebuildRollups } from '@gscdump/engine/rollups'
import { defineCommand } from 'citty'
import { createCommandContext } from '../context'
import { allTables } from '../local-store'
import { applyOutputMode, logger, OUTPUT_ARGS } from '../utils'

// Build the versioned query→canonical(+intent) dimension for a site from its
// distinct queries, so the canonical rollups JOIN current-version canonical
// instead of the stored fact column (ADR-0019 / ADR-0020). Returns the row count.
async function buildSiteQueryDim(
  store: NonNullable<Awaited<ReturnType<typeof createCommandContext>>['store']>,
  siteId: string,
): Promise<number> {
  const ctx = { userId: store.userId, siteId }
  const entries = await store.engine.listLive({ userId: ctx.userId, siteId, table: 'queries' as TableName })
  if (entries.length === 0)
    return 0
  const { rows } = await store.engine.runSQL({
    ctx,
    table: 'queries' as TableName,
    fileSets: { FILES: { table: 'queries' as TableName, partitions: entries.map(e => e.partition) } },
    sql: `SELECT DISTINCT query FROM read_parquet({{FILES}}, union_by_name = true) WHERE query IS NOT NULL`,
  })
  const records = buildQueryDimRecords(rows.map(r => String(r.query)), {
    normalizeQuery,
    normalizerVersion: NORMALIZER_VERSION,
    classifyIntentCode: q => encodeIntent(classifyQueryIntent(q)),
    intentVersion: INTENT_CLASSIFIER_VERSION,
  })
  await createQueryDimStore({ dataSource: store.dataSource }).write(ctx, records, Date.now())
  return records.length
}

const rebuildSubCommand = defineCommand({
  meta: {
    name: 'rebuild',
    description: 'Rebuild post-sync rollups (daily totals, weekly totals, top-N tables) for a site',
  },
  args: {
    ...OUTPUT_ARGS,
    'site': {
      type: 'string',
      alias: 's',
      description: 'Restrict to a single site (default: all sites with local data)',
    },
    'with-canonical': {
      type: 'boolean',
      description: 'Also build the opt-in canonical-primary rollups (query_canonical_variants, query_canonical_daily)',
      default: false,
    },
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const defs = args['with-canonical'] ? [...DEFAULT_ROLLUPS, ...CANONICAL_ROLLUPS] : DEFAULT_ROLLUPS
    const ctx = await createCommandContext({ needsStore: true })
    const store = ctx.store!
    const explicitSiteId = args.site ? store.siteIdFor(String(args.site)) : undefined

    // Discover sites with local data — rollups run per-site so we don't
    // bother rebuilding for sites the user hasn't synced.
    const allSiteIds = new Set<string>()
    if (explicitSiteId) {
      allSiteIds.add(explicitSiteId)
    }
    else {
      for (const table of allTables()) {
        const entries = await store.engine.listLive({
          userId: store.userId,
          table: table as TableName,
        })
        for (const e of entries) {
          if (e.siteId)
            allSiteIds.add(e.siteId)
        }
      }
    }

    if (allSiteIds.size === 0) {
      if (json)
        console.log(JSON.stringify({ sites: [], totalBytes: 0 }, null, 2))
      else
        logger.warn('No sites with local data. Run `gscdump sync` first.')
      return
    }

    const summary: Array<{ siteId: string, rollups: Array<{ id: string, bytes: number, objectKey: string }> }> = []
    let totalBytes = 0
    for (const siteId of allSiteIds) {
      if (args['with-canonical']) {
        const dimRows = await buildSiteQueryDim(store, siteId)
        if (!json)
          logger.info(`Built query dimension for [${siteId}] (${dimRows} distinct queries, normalizer v${NORMALIZER_VERSION})`)
      }
      logger.info(`Rebuilding rollups for [${siteId}] (${defs.length} rollups)`)
      const results = await rebuildRollups({
        engine: {
          runSQL: opts => store.engine.runSQL(opts),
          listPartitions: async ({ ctx, table, searchType }) => {
            const entries = await store.engine.listLive({
              userId: ctx.userId,
              ...(ctx.siteId !== undefined ? { siteId: ctx.siteId } : {}),
              table,
              ...(searchType !== undefined ? { searchType } : {}),
            })
            return entries.map(e => ({ partition: e.partition, bytes: e.bytes }))
          },
        },
        dataSource: store.dataSource,
        ctx: { userId: store.userId, siteId },
        defs,
      })
      const site = { siteId, rollups: [] as Array<{ id: string, bytes: number, objectKey: string }> }
      for (const r of results) {
        totalBytes += r.bytes
        site.rollups.push({ id: r.id, bytes: r.bytes, objectKey: r.objectKey })
        if (!json)
          console.log(`  ${r.id.padEnd(20)} ${(r.bytes / 1024).toFixed(1).padStart(8)} KB  ${r.objectKey}`)
      }
      summary.push(site)
    }

    if (json) {
      console.log(JSON.stringify({ sites: summary, totalBytes }, null, 2))
      return
    }
    logger.success(`Rebuilt rollups across ${allSiteIds.size} site(s) — total ${(totalBytes / 1024).toFixed(1)} KB`)
  },
})

export const rollupsCommand = defineCommand({
  meta: {
    name: 'rollups',
    description: 'Manage post-sync rollups',
  },
  subCommands: {
    rebuild: rebuildSubCommand,
  },
})
