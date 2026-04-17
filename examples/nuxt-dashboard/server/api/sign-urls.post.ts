// Bulk variant of /api/sign-url. Client sends { keys: string[] }, gets
// { urls: Record<key, url> } back in one round-trip. Matters when the
// manifest covers thousands of partitions — firing a GET per key saturates
// the browser's concurrent-connection limit and Chrome bails with
// ERR_INSUFFICIENT_RESOURCES.

import { useR2Client } from '../utils/r2-client'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ keys?: unknown, ttl?: unknown }>(event)
  const keys = Array.isArray(body?.keys) ? body.keys.filter((k): k is string => typeof k === 'string') : []
  if (keys.length === 0)
    throw createError({ statusCode: 400, statusMessage: 'missing keys[]' })
  if (keys.length > 10000)
    throw createError({ statusCode: 400, statusMessage: `too many keys: ${keys.length} (max 10000)` })

  const allowedUser = useRuntimeConfig().gscUserId
  if (allowedUser) {
    const prefix = `u_${allowedUser}/`
    for (const k of keys) {
      if (!k.startsWith(prefix))
        throw createError({ statusCode: 403, statusMessage: 'key outside allowed prefix' })
    }
  }

  const r2 = useR2Client()
  const expiresIn = typeof body?.ttl === 'number' ? body.ttl : 3600

  // Sign in parallel — aws4fetch is CPU-bound HMAC, no I/O.
  const entries = await Promise.all(
    keys.map(async key => [key, await r2.presignGet(key, expiresIn)] as const),
  )
  return { urls: Object.fromEntries(entries), expiresIn }
})
