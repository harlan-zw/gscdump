import { defineCommand } from 'citty'
import { HOSTED_ARGS, resolveHostedSiteWithTarget } from '../hosted-site'
import { renderTable } from '../render/layout'
import { terminalOutputOptions } from '../render/terminal'
import { applyOutputMode, logger, OUTPUT_ARGS } from '../utils'

const LOCAL_ALTERNATIVE = 'run `gscdump inspect --site <site>` and read saved results with `gscdump entities`'

export const indexingCanonicalMismatchesCommand = defineCommand({
  meta: {
    name: 'canonical-mismatches',
    description: 'List URLs where Google selected a different canonical than the declared canonical (hosted)',
  },
  args: {
    target: { type: 'positional', required: false, description: 'Site URL or Site ID (or pass --site)' },
    ...HOSTED_ARGS,
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const { client, site } = await resolveHostedSiteWithTarget(
      args as Record<string, unknown>,
      { name: 'indexing canonical-mismatches', localAlternative: LOCAL_ALTERNATIVE },
      args.target ? String(args.target) : undefined,
    )
    const { data } = await client.getCanonicalMismatches({ params: { siteId: site.siteId } })
    if (json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }
    if (data.mismatches.length === 0) {
      logger.info(`No canonical mismatches found for ${site.siteUrl}.`)
      return
    }
    for (const line of renderTable(
      data.mismatches.map(row => ({
        url: row.url,
        kind: row.kind,
        userCanonical: row.userCanonical,
        googleCanonical: row.googleCanonical,
        coverageState: row.coverageState ?? '',
      })),
      [
        { key: 'url', label: 'URL' },
        { key: 'kind', label: 'Kind' },
        { key: 'userCanonical', label: 'Declared canonical' },
        { key: 'googleCanonical', label: 'Google canonical' },
        { key: 'coverageState', label: 'Coverage state' },
      ],
      terminalOutputOptions(),
    )) {
      console.log(line)
    }
    logger.info(`${data.totalCount} canonical mismatch${data.totalCount === 1 ? '' : 'es'} on ${site.siteUrl}.`)
  },
})
