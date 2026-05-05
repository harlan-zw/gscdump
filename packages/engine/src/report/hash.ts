/**
 * Deterministic input hash for a report run.
 *
 *   inputHash = sha256(id|site|resolvedWindow|paramsCanonical|registryVersion)
 *
 * `generatedAt` is excluded by construction — same inputs ⇒ same hash, so
 * downstream caches can dedupe runs. Param objects are canonicalised
 * (sorted keys, recursive) before hashing so map ordering doesn't leak in.
 *
 * Edge-compatible: uses Web Crypto via `globalThis.crypto.subtle`. Node 18+
 * exposes this, browsers and Workers expose it natively.
 */

import type { ResolvedWindow } from '../period'
import type { ReportParams } from './types'

export interface InputHashSeeds {
  id: string
  site: string
  window: ResolvedWindow
  params: ReportParams
  registryVersion: string
}

/** Stable JSON: sorts object keys at every level. Arrays preserve order. */
export function canonicalize(value: unknown): unknown {
  if (value == null || typeof value !== 'object')
    return value
  if (Array.isArray(value))
    return value.map(canonicalize)
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(value as Record<string, unknown>).sort())
    out[k] = canonicalize((value as Record<string, unknown>)[k])
  return out
}

export async function computeInputHash(seeds: InputHashSeeds): Promise<string> {
  const payload = JSON.stringify(canonicalize({
    id: seeds.id,
    site: seeds.site,
    window: { start: seeds.window.start, end: seeds.window.end, comparison: seeds.window.comparison ?? null },
    params: seeds.params,
    registryVersion: seeds.registryVersion,
  }))
  const bytes = new TextEncoder().encode(payload)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return bufferToHex(digest)
}

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let out = ''
  for (let i = 0; i < bytes.length; i++)
    out += bytes[i]!.toString(16).padStart(2, '0')
  return out
}
