import type { TenantCtx } from '@gscdump/contracts'
import type { DataSource } from '../storage'
import { encodeJsonBigintSafe } from '@gscdump/lakehouse/bigint'
import { readOptional } from '../adapters/read-optional'
import { emptyTypesKey } from '../entity-keys'

export interface EmptyTypesDoc {
  version: 1
  /** SearchType strings detected as empty for this (user, site). */
  emptyTypes: string[]
  /** When each type was last marked empty (unix ms). Helps debug stale skips. */
  markedAt: Record<string, number>
}

export interface EmptyTypesStore {
  load: (ctx: TenantCtx) => Promise<EmptyTypesDoc>
  /** Add types to the empty set, preserving existing markers. No-op if all already present. */
  mark: (ctx: TenantCtx, types: readonly string[], now?: number) => Promise<EmptyTypesDoc>
  /** Remove types from the empty set. Returns the updated doc. */
  clear: (ctx: TenantCtx, types: readonly string[]) => Promise<EmptyTypesDoc>
}

export interface CreateEmptyTypesStoreOptions {
  dataSource: DataSource
  now?: () => number
}

export function createEmptyTypesStore(opts: CreateEmptyTypesStoreOptions): EmptyTypesStore {
  const ds = opts.dataSource
  const now = opts.now ?? (() => Date.now())

  async function readDoc(key: string): Promise<EmptyTypesDoc> {
    // Absent doc → the empty default (first-run no-op). A real read failure or a
    // parse error propagates rather than reading as "no empty types", which
    // would re-probe every searchType on the next sync or lose markers on write.
    const bytes = await readOptional(ds, key)
    if (bytes === undefined)
      return { version: 1, emptyTypes: [], markedAt: {} }
    return JSON.parse(new TextDecoder().decode(bytes)) as EmptyTypesDoc
  }

  async function writeDoc(key: string, doc: EmptyTypesDoc): Promise<void> {
    await ds.write(key, encodeJsonBigintSafe(doc))
  }

  return {
    async load(ctx) {
      return readDoc(emptyTypesKey(ctx))
    },

    async mark(ctx, types, at) {
      if (types.length === 0)
        return readDoc(emptyTypesKey(ctx))
      const key = emptyTypesKey(ctx)
      const doc = await readDoc(key)
      const stamp = at ?? now()
      let changed = false
      for (const t of types) {
        if (!doc.emptyTypes.includes(t)) {
          doc.emptyTypes.push(t)
          changed = true
        }
        if (doc.markedAt[t] === undefined) {
          doc.markedAt[t] = stamp
          changed = true
        }
      }
      if (changed) {
        doc.emptyTypes.sort()
        await writeDoc(key, doc)
      }
      return doc
    },

    async clear(ctx, types) {
      if (types.length === 0)
        return readDoc(emptyTypesKey(ctx))
      const key = emptyTypesKey(ctx)
      const doc = await readDoc(key)
      const drop = new Set(types)
      const before = doc.emptyTypes.length
      doc.emptyTypes = doc.emptyTypes.filter(t => !drop.has(t))
      for (const t of drop) delete doc.markedAt[t]
      if (doc.emptyTypes.length !== before)
        await writeDoc(key, doc)
      return doc
    },
  }
}
