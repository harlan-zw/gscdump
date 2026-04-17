// Presign one R2 GET URL. Called by the client-side DuckDB-WASM httpfs
// reader via `createHttpDataSource({ signUrl })` — every parquet read
// hits this route, gets a short-lived URL, and fetches directly from R2.

import { useR2Client } from '../utils/r2-client'

export default defineEventHandler(async (event) => {
  const key = getQuery(event).key as string | undefined
  if (!key)
    throw createError({ statusCode: 400, statusMessage: 'missing key' })

  // Only allow keys that start with the user's own prefix. In gscdump.com's
  // version this would be the session's userId; here we pin to the env.
  const allowedUser = useRuntimeConfig().gscUserId
  if (allowedUser && !key.startsWith(`u_${allowedUser}/`))
    throw createError({ statusCode: 403, statusMessage: 'key outside allowed prefix' })

  const r2 = useR2Client()
  const expiresIn = Number(getQuery(event).ttl ?? 3600)
  const url = await r2.presignGet(key, expiresIn)
  return { url, expiresIn }
})
