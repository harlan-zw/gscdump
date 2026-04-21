import process from 'node:process'
import { defineCommand } from 'citty'
import { createCommandContext } from '../context'
import { logger } from '../utils'

export const inspectCommand = defineCommand({
  meta: {
    name: 'inspect',
    description: 'Inspect a specific URL\'s indexing status',
  },
  args: {
    site: { type: 'string', alias: 's', required: true, description: 'Site URL (e.g., sc-domain:example.com)' },
    url: { type: 'positional', required: true, description: 'URL to inspect' },
    json: { type: 'boolean', default: false, description: 'Output as JSON' },
  },
  async run({ args }) {
    const ctx = await createCommandContext({ needsAuth: true })
    const client = ctx.client!

    const result = await client.inspect(args.site, args.url).catch((e: Error) => {
      logger.error(`Inspection failed: ${e.message}`)
      process.exit(1)
    })

    const inspection = result?.inspectionResult
    const indexStatus = inspection?.indexStatusResult

    if (args.json) {
      console.log(JSON.stringify({
        url: args.url,
        verdict: indexStatus?.verdict || null,
        coverageState: indexStatus?.coverageState || null,
        indexingState: indexStatus?.indexingState || null,
        lastCrawlTime: indexStatus?.lastCrawlTime || null,
        isIndexed: indexStatus?.verdict === 'PASS',
        raw: result,
      }, null, 2))
      return
    }

    console.log()
    console.log(`  \x1B[1mURL:\x1B[0m ${args.url}`)
    console.log()

    const verdictColor = indexStatus?.verdict === 'PASS' ? '\x1B[32m' : '\x1B[31m'
    console.log(`  Verdict:        ${verdictColor}${indexStatus?.verdict || 'N/A'}\x1B[0m`)
    if (indexStatus?.coverageState)
      console.log(`  Coverage:       ${indexStatus.coverageState}`)
    if (indexStatus?.indexingState)
      console.log(`  Indexing:       ${indexStatus.indexingState}`)
    if (indexStatus?.lastCrawlTime)
      console.log(`  Last Crawl:     ${indexStatus.lastCrawlTime}`)
    if (indexStatus?.robotsTxtState)
      console.log(`  Robots.txt:     ${indexStatus.robotsTxtState}`)
    if (indexStatus?.pageFetchState)
      console.log(`  Page Fetch:     ${indexStatus.pageFetchState}`)
    if (indexStatus?.googleCanonical)
      console.log(`  Google Canon:   ${indexStatus.googleCanonical}`)
    if (indexStatus?.userCanonical)
      console.log(`  User Canon:     ${indexStatus.userCanonical}`)
    console.log()
  },
})
