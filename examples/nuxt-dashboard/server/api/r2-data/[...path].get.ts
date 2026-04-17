// Parquet byte proxy. Two backends:
//   - GSCDUMP_DATA_DIR set → stream from local filesystem.
//   - otherwise → presign + stream from R2.
//
// Same URL shape either way; the composable doesn't care which backend is live.

import { createReadStream, statSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { sendStream } from 'h3'
import { useR2Client } from '../../utils/r2-client'

const BYTE_RANGE_RE = /^bytes=(\d+)-(\d*)$/

export default defineEventHandler(async (event) => {
  const segments = getRouterParam(event, 'path') ?? ''
  const key = Array.isArray(segments) ? segments.join('/') : segments
  if (!key)
    throw createError({ statusCode: 400, statusMessage: 'missing object key' })

  const cfg = useRuntimeConfig()
  const allowedUser = cfg.gscUserId
  if (allowedUser && !key.startsWith(`u_${allowedUser}/`))
    throw createError({ statusCode: 403, statusMessage: 'key outside allowed prefix' })

  // Local mode
  if (cfg.gscDataDir) {
    const abs = normalize(join(cfg.gscDataDir, key))
    const root = `${normalize(cfg.gscDataDir)}/`
    if (!abs.startsWith(root))
      throw createError({ statusCode: 400, statusMessage: 'path traversal blocked' })
    const st = statSync(abs)
    const range = getHeader(event, 'range')
    if (range) {
      const m = BYTE_RANGE_RE.exec(range)
      if (m) {
        const start = Number(m[1])
        const end = m[2] ? Number(m[2]) : st.size - 1
        setResponseStatus(event, 206)
        setHeaders(event, {
          'content-type': 'application/octet-stream',
          'content-length': String(end - start + 1),
          'content-range': `bytes ${start}-${end}/${st.size}`,
          'accept-ranges': 'bytes',
          'cache-control': 'public, max-age=31536000, immutable',
        })
        return sendStream(event, createReadStream(abs, { start, end }))
      }
    }
    setHeaders(event, {
      'content-type': 'application/octet-stream',
      'content-length': String(st.size),
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=31536000, immutable',
    })
    return sendStream(event, createReadStream(abs))
  }

  // R2 mode: presign + forward.
  const r2 = useR2Client()
  const sizeHint = getQuery(event).s
  const method = event.method

  if (method === 'HEAD' && typeof sizeHint === 'string' && sizeHint) {
    setResponseStatus(event, 200)
    setHeaders(event, {
      'content-length': sizeHint,
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=31536000, immutable',
    })
    return null
  }

  const signedUrl = await r2.presignGet(key)
  const upstreamHeaders: Record<string, string> = {}
  const range = getHeader(event, 'range')
  if (range)
    upstreamHeaders.range = range

  const upstream = await fetch(signedUrl, { method, headers: upstreamHeaders })
  setResponseStatus(event, upstream.status)
  const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag']
  for (const h of passthrough) {
    const v = upstream.headers.get(h)
    if (v)
      setHeader(event, h, v)
  }
  setHeader(event, 'cache-control', 'public, max-age=31536000, immutable')
  return upstream.body
})
