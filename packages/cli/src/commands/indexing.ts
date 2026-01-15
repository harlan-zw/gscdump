import path from 'node:path'
import process from 'node:process'
import {
  batchInspectUrls,
  batchRequestIndexingForPaths,
  createGscDb,
  getIndexingStats,
  getSiteByProperty,
  setupSchema,
  sitePathDateAnalytics,
  syncSites,
} from '@gscdump/db'
import { defineCommand } from 'citty'
import betterSqlite3 from 'db0/connectors/better-sqlite3'
import { eq } from 'drizzle-orm'
import { googleSearchConsole } from 'gscdump'
import { loadConfig } from '../config'
import { clearLine, gscErrorHandler, logger, progressBar } from '../utils'

// Export inspect as standalone command for `gscdump inspect` shorthand
export const inspectCommand = defineCommand({
  meta: {
    name: 'inspect',
    description: 'Inspect URLs to check their indexing status (shorthand for `gscdump index inspect`)',
  },
  args: {
    db: {
      type: 'string',
      alias: 'd',
      default: './gscdump.db',
      description: 'SQLite database path',
    },
    site: {
      type: 'string',
      alias: 's',
      description: 'Site URL (e.g., sc-domain:example.com)',
    },
    limit: {
      type: 'string',
      alias: 'l',
      default: '100',
      description: 'Max URLs to inspect',
    },
    delay: {
      type: 'string',
      default: '200',
      description: 'Delay between requests (ms)',
    },
    quiet: {
      type: 'boolean',
      alias: 'q',
      default: false,
      description: 'Suppress progress output',
    },
    json: {
      type: 'boolean',
      default: false,
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    const config = await loadConfig()
    const dbPath = String(args.db === './gscdump.db' && config.defaultDb ? config.defaultDb : args.db)
    const siteArg = String(args.site || config.defaultSite || '')

    if (!siteArg) {
      logger.error('Site required. Use --site or set defaultSite in config.')
      process.exit(1)
    }

    const { getAuth } = await import('../auth')
    const auth = await getAuth({ interactive: false, config })
    const client = googleSearchConsole(auth)

    const resolvedPath = path.resolve(dbPath)
    const { db, db0 } = createGscDb(betterSqlite3({ name: resolvedPath }))
    await setupSchema(db0)

    await syncSites(db, client).catch(gscErrorHandler)

    const siteRecord = await getSiteByProperty(db, siteArg)
    if (!siteRecord) {
      logger.error(`Site not found: ${siteArg}`)
      process.exit(1)
    }

    // @ts-expect-error db0 raw column names
    const siteId = siteRecord.site_id || siteRecord.siteId
    const limit = Number.parseInt(String(args.limit), 10)
    const delayMs = Number.parseInt(String(args.delay), 10)

    // Get paths from analytics data
    const paths = await db.selectDistinct({ path: sitePathDateAnalytics.path })
      .from(sitePathDateAnalytics)
      .where(eq(sitePathDateAnalytics.siteId, siteId))
      .limit(limit)

    if (paths.length === 0) {
      logger.warn('No URLs found. Run `gscdump sync` first.')
      return
    }

    if (!args.quiet && !args.json)
      logger.info(`Inspecting ${paths.length} URLs...`)

    const results: { path: string, isIndexed: boolean, error?: string }[] = []

    const stats = await batchInspectUrls(db, client, siteId, siteArg, paths.map(p => p.path), {
      delayMs,
      onProgress: (result, i, total) => {
        results.push(result)
        if (!args.quiet && !args.json) {
          clearLine()
          process.stdout.write(progressBar(i + 1, total, result.path.slice(0, 40)))
        }
      },
    }).catch(gscErrorHandler)

    if (!args.quiet && !args.json)
      clearLine()

    if (args.json) {
      console.log(JSON.stringify({ stats, results }, null, 2))
    }
    else {
      console.log()
      logger.success(`Inspected ${paths.length} URLs`)
      console.log(`  Indexed:     ${stats.indexed}`)
      console.log(`  Not Indexed: ${stats.notIndexed}`)
      console.log(`  Errors:      ${stats.errors}`)
      console.log()
    }
  },
})

export const indexingCommand = defineCommand({
  meta: {
    name: 'index',
    description: 'Manage URL indexing via Google Indexing API',
  },
  subCommands: {
    status: defineCommand({
      meta: {
        name: 'status',
        description: 'Show indexing status for URLs',
      },
      args: {
        db: {
          type: 'string',
          alias: 'd',
          default: './gscdump.db',
          description: 'SQLite database path',
        },
        site: {
          type: 'string',
          alias: 's',
          description: 'Site URL (e.g., sc-domain:example.com)',
        },
        json: {
          type: 'boolean',
          default: false,
          description: 'Output as JSON',
        },
      },
      async run({ args }) {
        const config = await loadConfig()
        const dbPath = String(args.db === './gscdump.db' && config.defaultDb ? config.defaultDb : args.db)
        const siteArg = String(args.site || config.defaultSite || '')

        if (!siteArg) {
          logger.error('Site required. Use --site or set defaultSite in config.')
          process.exit(1)
        }

        const resolvedPath = path.resolve(dbPath)
        const { db, db0 } = createGscDb(betterSqlite3({ name: resolvedPath }))
        await setupSchema(db0)

        const siteRecord = await getSiteByProperty(db, siteArg)
        if (!siteRecord) {
          logger.error(`Site not found: ${siteArg}`)
          process.exit(1)
        }

        // @ts-expect-error db0 raw column names
        const siteId = siteRecord.site_id || siteRecord.siteId
        const stats = await getIndexingStats(db, siteId)

        if (args.json) {
          console.log(JSON.stringify(stats, null, 2))
        }
        else {
          console.log()
          logger.info(`Indexing Status for ${siteArg}`)
          console.log()
          console.log(`  Total URLs:    ${stats.total}`)
          console.log(`  Indexed:       ${stats.indexed} (${stats.total ? Math.round(stats.indexed / stats.total * 100) : 0}%)`)
          console.log(`  Not Indexed:   ${stats.notIndexed}`)
          console.log(`  Unknown:       ${stats.unknown}`)
          console.log(`  Requested:     ${stats.requested}`)
          console.log()
        }
      },
    }),

    inspect: defineCommand({
      meta: {
        name: 'inspect',
        description: 'Inspect URLs to check their indexing status',
      },
      args: {
        db: {
          type: 'string',
          alias: 'd',
          default: './gscdump.db',
          description: 'SQLite database path',
        },
        site: {
          type: 'string',
          alias: 's',
          description: 'Site URL (e.g., sc-domain:example.com)',
        },
        limit: {
          type: 'string',
          alias: 'l',
          default: '100',
          description: 'Max URLs to inspect',
        },
        delay: {
          type: 'string',
          default: '200',
          description: 'Delay between requests (ms)',
        },
        quiet: {
          type: 'boolean',
          alias: 'q',
          default: false,
          description: 'Suppress progress output',
        },
        json: {
          type: 'boolean',
          default: false,
          description: 'Output as JSON',
        },
      },
      async run({ args }) {
        const config = await loadConfig()
        const dbPath = String(args.db === './gscdump.db' && config.defaultDb ? config.defaultDb : args.db)
        const siteArg = String(args.site || config.defaultSite || '')

        if (!siteArg) {
          logger.error('Site required. Use --site or set defaultSite in config.')
          process.exit(1)
        }

        const { getAuth } = await import('../auth')
        const auth = await getAuth({ interactive: false, config })
        const client = googleSearchConsole(auth)

        const resolvedPath = path.resolve(dbPath)
        const { db, db0 } = createGscDb(betterSqlite3({ name: resolvedPath }))
        await setupSchema(db0)

        await syncSites(db, client).catch(gscErrorHandler)

        const siteRecord = await getSiteByProperty(db, siteArg)
        if (!siteRecord) {
          logger.error(`Site not found: ${siteArg}`)
          process.exit(1)
        }

        // @ts-expect-error db0 raw column names
        const siteId = siteRecord.site_id || siteRecord.siteId
        const limit = Number.parseInt(String(args.limit), 10)
        const delayMs = Number.parseInt(String(args.delay), 10)

        // Get paths from analytics data
        const paths = await db.selectDistinct({ path: sitePathDateAnalytics.path })
          .from(sitePathDateAnalytics)
          .where(eq(sitePathDateAnalytics.siteId, siteId))
          .limit(limit)

        if (paths.length === 0) {
          logger.warn('No URLs found. Run `gscdump sync` first.')
          return
        }

        if (!args.quiet && !args.json)
          logger.info(`Inspecting ${paths.length} URLs...`)

        const results: { path: string, isIndexed: boolean, error?: string }[] = []

        const stats = await batchInspectUrls(db, client, siteId, siteArg, paths.map(p => p.path), {
          delayMs,
          onProgress: (result, i, total) => {
            results.push(result)
            if (!args.quiet && !args.json) {
              clearLine()
              process.stdout.write(progressBar(i + 1, total, result.path.slice(0, 40)))
            }
          },
        }).catch(gscErrorHandler)

        if (!args.quiet && !args.json)
          clearLine()

        if (args.json) {
          console.log(JSON.stringify({ stats, results }, null, 2))
        }
        else {
          console.log()
          logger.success(`Inspected ${paths.length} URLs`)
          console.log(`  Indexed:     ${stats.indexed}`)
          console.log(`  Not Indexed: ${stats.notIndexed}`)
          console.log(`  Errors:      ${stats.errors}`)
          console.log()
        }
      },
    }),

    request: defineCommand({
      meta: {
        name: 'request',
        description: 'Request indexing for URLs via Google Indexing API',
      },
      args: {
        'db': {
          type: 'string',
          alias: 'd',
          default: './gscdump.db',
          description: 'SQLite database path',
        },
        'site': {
          type: 'string',
          alias: 's',
          description: 'Site URL (e.g., sc-domain:example.com)',
        },
        'limit': {
          type: 'string',
          alias: 'l',
          default: '200',
          description: 'Max URLs to request (API quota: 200/day)',
        },
        'delay': {
          type: 'string',
          default: '100',
          description: 'Delay between requests (ms)',
        },
        'type': {
          type: 'string',
          alias: 't',
          default: 'URL_UPDATED',
          description: 'Notification type: URL_UPDATED or URL_DELETED',
        },
        'not-indexed': {
          type: 'boolean',
          default: true,
          description: 'Only request for non-indexed URLs',
        },
        'quiet': {
          type: 'boolean',
          alias: 'q',
          default: false,
          description: 'Suppress progress output',
        },
        'json': {
          type: 'boolean',
          default: false,
          description: 'Output as JSON',
        },
      },
      async run({ args }) {
        const config = await loadConfig()
        const dbPath = String(args.db === './gscdump.db' && config.defaultDb ? config.defaultDb : args.db)
        const siteArg = String(args.site || config.defaultSite || '')

        if (!siteArg) {
          logger.error('Site required. Use --site or set defaultSite in config.')
          process.exit(1)
        }

        const { getAuth } = await import('../auth')
        const auth = await getAuth({ interactive: false, config })
        const client = googleSearchConsole(auth)

        const resolvedPath = path.resolve(dbPath)
        const { db, db0 } = createGscDb(betterSqlite3({ name: resolvedPath }))
        await setupSchema(db0)

        await syncSites(db, client).catch(gscErrorHandler)

        const siteRecord = await getSiteByProperty(db, siteArg)
        if (!siteRecord) {
          logger.error(`Site not found: ${siteArg}`)
          process.exit(1)
        }

        // @ts-expect-error db0 raw column names
        const siteId = siteRecord.site_id || siteRecord.siteId
        const limit = Number.parseInt(String(args.limit), 10)
        const delayMs = Number.parseInt(String(args.delay), 10)
        const type = String(args.type) as 'URL_UPDATED' | 'URL_DELETED'

        // Get paths from analytics data
        const paths = await db.selectDistinct({ path: sitePathDateAnalytics.path })
          .from(sitePathDateAnalytics)
          .where(eq(sitePathDateAnalytics.siteId, siteId))
          .limit(limit)

        if (paths.length === 0) {
          logger.warn('No URLs found. Run `gscdump sync` first.')
          return
        }

        if (!args.quiet && !args.json) {
          logger.info(`Requesting indexing for ${paths.length} URLs...`)
          logger.warn('Note: Indexing API quota is typically 200 requests/day')
        }

        const results: { url: string, error?: string }[] = []

        const stats = await batchRequestIndexingForPaths(db, client, siteId, siteArg, paths.map(p => p.path), {
          type,
          delayMs,
          onProgress: (result, i, total) => {
            results.push(result)
            if (!args.quiet && !args.json) {
              clearLine()
              const status = result.error ? 'ERR' : 'OK'
              process.stdout.write(progressBar(i + 1, total, `[${status}] ${result.url.slice(-40)}`))
            }
          },
        }).catch(gscErrorHandler)

        if (!args.quiet && !args.json)
          clearLine()

        if (args.json) {
          console.log(JSON.stringify({ stats, results }, null, 2))
        }
        else {
          console.log()
          logger.success(`Requested indexing for ${paths.length} URLs`)
          console.log(`  Success: ${stats.success}`)
          console.log(`  Errors:  ${stats.errors}`)
          console.log()

          if (stats.errors > 0) {
            const errorResults = results.filter(r => r.error)
            logger.warn('Errors:')
            errorResults.slice(0, 5).forEach((r) => {
              console.log(`  ${r.url}: ${r.error}`)
            })
            if (errorResults.length > 5)
              console.log(`  ... and ${errorResults.length - 5} more`)
          }
        }
      },
    }),
  },
})
