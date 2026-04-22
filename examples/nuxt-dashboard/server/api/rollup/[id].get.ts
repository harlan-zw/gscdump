// Returns the latest rollup envelope (JSON) for the given id. Two backends:
//   - GSCDUMP_DATA_DIR set → read the newest u_<u>/<s>/rollups/<id>__v<ts>.json from disk.
//   - otherwise → R2 LIST the rollups/ prefix, pick newest, read its bytes.
//
// The rollup writer is content-addressable (filename includes builtAt).
// We pick the max builtAt per id. Immutable snapshots → long-cache the
// JSON payload; fetching the id always returns "latest" with a short TTL.

import type { RollupEnvelope } from '@gscdump/engine/rollups'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { useR2Client } from '../../utils/r2-client'

const ROLLUP_FILE_RE = /^(?<id>[a-z0-9_]+)__v(?<ts>\d+)\.json$/

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id)
    throw createError({ statusCode: 400, statusMessage: 'missing id' })

  const cfg = useRuntimeConfig()
  const userId = (getQuery(event).user as string | undefined) ?? cfg.gscUserId
  const siteId = (getQuery(event).site as string | undefined) ?? cfg.gscSiteId
  if (!userId)
    throw createError({ statusCode: 400, statusMessage: 'missing user (pass ?user= or set GSCDUMP_USER_ID)' })

  setHeader(event, 'Cache-Control', 'private, max-age=30')

  if (cfg.gscDataDir) {
    const rollupsDir = siteId
      ? join(cfg.gscDataDir, `u_${userId}`, siteId, 'rollups')
      : join(cfg.gscDataDir, `u_${userId}`, 'rollups')
    const dir = await readdir(rollupsDir).catch(() => [])
    let newest: { ts: number, file: string } | null = null
    for (const f of dir) {
      const m = ROLLUP_FILE_RE.exec(f)
      if (!m?.groups || m.groups.id !== id)
        continue
      const ts = Number(m.groups.ts)
      if (!newest || ts > newest.ts)
        newest = { ts, file: f }
    }
    if (!newest)
      throw createError({ statusCode: 404, statusMessage: `no rollup ${id} under ${rollupsDir}` })
    const text = await readFile(join(rollupsDir, newest.file), 'utf8')
    return JSON.parse(text) as RollupEnvelope
  }

  const prefix = siteId
    ? `u_${userId}/${siteId}/rollups/`
    : `u_${userId}/rollups/`
  const r2 = useR2Client()
  let newest: { ts: number, key: string } | null = null
  for await (const obj of r2.listObjects(prefix)) {
    const name = obj.key.slice(prefix.length)
    const m = ROLLUP_FILE_RE.exec(name)
    if (!m?.groups || m.groups.id !== id)
      continue
    const ts = Number(m.groups.ts)
    if (!newest || ts > newest.ts)
      newest = { ts, key: obj.key }
  }
  if (!newest)
    throw createError({ statusCode: 404, statusMessage: `no rollup ${id} under r2:${prefix}` })
  const signedUrl = await r2.presignGet(newest.key, 60)
  const res = await fetch(signedUrl)
  if (!res.ok)
    throw createError({ statusCode: 502, statusMessage: `r2 fetch failed ${res.status}` })
  return (await res.json()) as RollupEnvelope
})
