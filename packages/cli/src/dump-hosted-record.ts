import type { GscdumpV1Client } from '@gscdump/sdk/v1'
import type { ReadableStream } from 'node:stream/web'
import type { HostedSite } from './hosted-site'
import { Buffer } from 'node:buffer'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGscdumpV1Client } from '@gscdump/sdk/v1'
import { getHostedAccount, hostedCredential } from './auth-state'
import { resolveCliEnvironment } from './environment'
import { hostedRequestContext } from './hosted-context'
import { resolveHostedAuthentication, resolveHostedSite } from './hosted-site'
import { commandLineError } from './stop'
import { parseNameList } from './utils'

type Manifest = Awaited<ReturnType<GscdumpV1Client['getSiteRecordExport']>>['data']
interface HostedDumpResult {
  outDir: string
  format: 'parquet'
  sites: Manifest[]
  files: Array<{ path: string, bytes: number }>
}

async function targetsFor(args: Record<string, unknown>): Promise<{ client: GscdumpV1Client, sites: HostedSite[] }> {
  const command = { name: 'dump', localAlternative: 'run the dump against your Store' }
  if (!args['all-sites']) {
    const { client, site } = await resolveHostedSite(args, command)
    return { client, sites: [site] }
  }
  const authentication = await resolveHostedAuthentication(args, command)
  const { sites } = await getHostedAccount(authentication)
  if (sites.length === 0)
    throw commandLineError('No Hosted Sites to export.')
  const client = createGscdumpV1Client({
    apiRoot: authentication.apiRoot,
    credential: hostedCredential(authentication),
    requestContext: hostedRequestContext(resolveCliEnvironment().values),
  })
  return { client, sites }
}

function selectedDatasets(manifest: Manifest, tables: ReadonlySet<string> | null, includeBing: boolean): Manifest['datasets'] {
  return manifest.datasets.filter(({ dataset }) => {
    const bing = dataset.startsWith('bing_')
    if (bing && !includeBing)
      return false
    return !tables || tables.has(dataset) || (bing && tables.has('bing'))
  })
}

async function assertParquet(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, 'r')
  try {
    const { size } = await handle.stat()
    const start = Buffer.alloc(4)
    const end = Buffer.alloc(4)
    if (size >= 12) {
      await handle.read(start, 0, 4, 0)
      await handle.read(end, 0, 4, size - 4)
    }
    if (start.toString() !== 'PAR1' || end.toString() !== 'PAR1')
      throw new Error('The Parquet download is incomplete.')
  }
  finally {
    await handle.close()
  }
}

export async function dumpHostedRecord(args: Record<string, unknown>, outDir: string): Promise<HostedDumpResult> {
  const { client, sites } = await targetsFor(args)
  const available: Manifest[] = []
  for (const site of sites) {
    const { data } = await client.getSiteRecordExport({ params: { siteId: site.siteId } })
    if (data.siteId !== site.siteId)
      throw new Error('The export manifest returned a different Site.')
    available.push(data)
  }
  const names = [...new Set(['bing', ...available.flatMap(manifest => manifest.datasets.map(dataset => dataset.dataset))])]
  const tables = args.tables === undefined ? null : new Set(parseNameList(args.tables, names, '--tables'))
  const manifests = available.map(manifest => ({ ...manifest, datasets: selectedDatasets(manifest, tables, args.bing !== false) }))
  if (manifests.every(manifest => manifest.datasets.length === 0))
    throw commandLineError('No Hosted datasets match this export. Run without --tables to download the record.')

  await fs.mkdir(outDir, { recursive: true })
  const staging = await fs.mkdtemp(path.join(outDir, '.record-export-'))
  const files: Array<{ path: string, bytes: number }> = []
  try {
    for (const manifest of manifests) {
      const folder = manifests.length > 1 ? manifest.siteId : ''
      if (folder && !/^s_[\w-]+$/.test(folder))
        throw new Error('The export manifest returned an invalid Site ID.')
      await fs.mkdir(path.join(staging, folder), { recursive: true })
      for (const { file } of manifest.datasets) {
        const relativePath = path.join(folder, file)
        const stagedPath = path.join(staging, relativePath)
        const response = await client.downloadSiteRecordExportFile({ params: { siteId: manifest.siteId, file } })
        if (!response.body)
          throw new Error('The Parquet download had no body.')
        await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), createWriteStream(stagedPath, { flags: 'wx' }))
        await assertParquet(stagedPath)
        files.push({ path: relativePath, bytes: (await fs.stat(stagedPath)).size })
      }
    }
    const manifest = { format: 'parquet' as const, sites: manifests, files }
    await fs.writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    for (const { path: relativePath } of [...files, { path: 'manifest.json' }]) {
      const destination = path.join(outDir, relativePath)
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.rename(path.join(staging, relativePath), destination)
    }
    return { outDir, ...manifest }
  }
  finally {
    await fs.rm(staging, { recursive: true, force: true })
  }
}
