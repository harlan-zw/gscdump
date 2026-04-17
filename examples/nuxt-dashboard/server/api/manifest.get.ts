// Returns a ManifestEntry[] JSON. Two backends:
//   - GSCDUMP_DATA_DIR set → read manifest.json from a local `gscdump sync` dump.
//   - otherwise → live R2 LIST under u_<userId>/<siteId?>/.

import type { ManifestEntry, TableName } from 'gscdump/analytics'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { useR2Client } from '../utils/r2-client'

const KEY_RE = /^u_(?<userId>[^/]+)\/(?:(?<siteId>[^/]+)\/)?(?<table>pages|keywords|countries|devices|page_keywords)\/(?<partition>[^_]+)__v\d+\.parquet$/

export default defineEventHandler(async (event) => {
  const cfg = useRuntimeConfig()
  const userId = (getQuery(event).user as string | undefined) ?? cfg.gscUserId
  const siteId = (getQuery(event).site as string | undefined) ?? cfg.gscSiteId
  if (!userId)
    throw createError({ statusCode: 400, statusMessage: 'missing user (pass ?user= or set GSCDUMP_USER_ID)' })

  // Local mode: read the manifest.json the filesystem adapter writes.
  if (cfg.gscDataDir) {
    const text = await readFile(join(cfg.gscDataDir, 'manifest.json'), 'utf8')
    const parsed = JSON.parse(text) as { version: 1, entries: ManifestEntry[], watermarks?: unknown[] }
    const entries = parsed.entries.filter(e => e.userId === userId && (!siteId || e.siteId === siteId))
    return { version: 1, entries, watermarks: [] }
  }

  // R2 mode: live LIST.
  const r2 = useR2Client()
  const prefix = siteId ? `u_${userId}/${siteId}/` : `u_${userId}/`
  const entries: ManifestEntry[] = []
  for await (const obj of r2.listObjects(prefix)) {
    const match = KEY_RE.exec(obj.key)
    if (!match?.groups)
      continue
    entries.push({
      userId: match.groups.userId!,
      siteId: match.groups.siteId,
      table: match.groups.table as TableName,
      partition: match.groups.partition!,
      objectKey: obj.key,
      rowCount: 0,
      bytes: obj.size,
      createdAt: new Date(obj.lastModified).getTime(),
    })
  }
  return { version: 1, entries, watermarks: [] }
})
