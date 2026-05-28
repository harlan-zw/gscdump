// HMAC for the `?s=<bytes>` size hint on /api/__gsc/r2-data URLs.
//
// Without a signature, an authenticated user can tamper `s` to lie about
// the object's size. DuckDB-WASM uses the Content-Length we return to plan
// range reads; a misaligned hint corrupts the reader. Signing pins the
// (key, bytes) pair to something the server vouched for.

import type { AnalyticsEnv } from './env'

// Full SHA-256 HMAC digest: 32 bytes → 64 hex chars. A truncated tag (the
// previous 8-byte/64-bit form) is forgeable far sooner than the full digest,
// and this signs a value DuckDB-WASM trusts for range planning.
const SIG_HEX_LEN = 64
const keyCache = new WeakMap<object, Promise<CryptoKey>>()
const stringKeyCache = new Map<string, Promise<CryptoKey>>()

async function getKey(env: AnalyticsEnv): Promise<CryptoKey> {
  const secret = env.TOKEN_ENCRYPTION_SECRET
  if (!secret)
    throw new Error('size-hint-sig: TOKEN_ENCRYPTION_SECRET not configured')
  // env is normally a stable object across one isolate's lifetime; cache by
  // identity. Fallback to string-keyed cache for unusual env shapes.
  let cached = keyCache.get(env as unknown as object)
  if (!cached) {
    cached = stringKeyCache.get(secret)
    if (!cached) {
      cached = crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret).slice().buffer,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify'],
      )
      stringKeyCache.set(secret, cached)
    }
    keyCache.set(env as unknown as object, cached)
  }
  return cached
}

function toHex(buf: ArrayBuffer, chars: number): string {
  const bytes = new Uint8Array(buf)
  let hex = ''
  for (let i = 0; i < chars / 2; i++)
    hex += bytes[i]!.toString(16).padStart(2, '0')
  return hex
}

function payload(key: string, bytes: number): ArrayBuffer {
  const encoded = new TextEncoder().encode(`${key}\0${bytes}`)
  // Copy to a fresh ArrayBuffer to satisfy SubtleCrypto's BufferSource typing
  // under @cloudflare/workers-types — TextEncoder returns Uint8Array<ArrayBufferLike>.
  return encoded.slice().buffer
}

export async function signSizeHint(env: AnalyticsEnv, key: string, bytes: number): Promise<string> {
  const cryptoKey = await getKey(env)
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, payload(key, bytes))
  return toHex(sig, SIG_HEX_LEN)
}

export async function verifySizeHint(env: AnalyticsEnv, key: string, bytes: number, providedHex: string): Promise<boolean> {
  if (providedHex.length !== SIG_HEX_LEN)
    return false
  const expected = await signSizeHint(env, key, bytes)
  // Constant-time compare. Lengths are equal by construction (both SIG_HEX_LEN).
  let diff = 0
  for (let i = 0; i < SIG_HEX_LEN; i++)
    diff |= expected.charCodeAt(i) ^ providedHex.charCodeAt(i)
  return diff === 0
}
