# Manual Sync Strategy for Hybrid Provider

## Status: DONE

Implementation complete. The hybrid provider now buffers data in memory and requires explicit `sync()` call to persist.

## Goal

Change hybrid provider to buffer fetched data in memory, requiring explicit `sync()` call to persist. This enables:
- Single transaction for all writes (faster, atomic)
- Caller controls when/if to persist
- Can defer sync after response
- No accidental writes

## Current Behavior

```ts
const provider = createProvider({ auth, db })
await provider.getPagesWithComparison(site, range) // fetches + writes immediately
```

## New Behavior

```ts
const provider = createProvider({ auth, db })
await provider.getPagesWithComparison(site, range) // fetches, buffers in memory
await provider.getKeywordsWithComparison(site, range) // fetches, buffers

await provider.sync() // single transaction write
// or
provider.discard() // clear buffer, no write
```

## Implementation

### 1. Add buffer state to hybrid provider

```ts
interface SyncBuffer {
  pages: Map<string, { siteId: number, date: string, rows: PageRow[] }>
  keywords: Map<string, { siteId: number, date: string, rows: KeywordRow[] }>
  countries: Map<string, { siteId: number, date: string, rows: CountryRow[] }>
  devices: Map<string, { siteId: number, date: string, rows: DeviceRow[] }>
}
```

Key: `${siteId}:${date}` to dedupe

### 2. Modify query methods

Instead of calling `syncPages()` etc, fetch from API and buffer:

```ts
getPagesWithComparison: async (siteUrl, range) => {
  const siteId = await ensureSiteId(siteUrl)
  const dateRange = toDateRange(range.period)

  // Check DB first
  if (await hasDataForRange(db, siteId, dateRange)) {
    return queryPagesWithComparison(db, siteId, ...)
  }

  // Check buffer
  const bufferKey = `${siteId}:${dateRange.startDate}:${dateRange.endDate}`
  if (buffer.pages.has(bufferKey)) {
    // Already fetched this session, query from buffer or DB
    return queryPagesWithComparison(db, siteId, ...)
  }

  // Fetch from API and buffer
  const result = await fetchPagesWithComparison(client, siteUrl, range)
  buffer.pages.set(bufferKey, {
    siteId,
    range,
    data: result.current,  // raw data for later insert
  })

  return result
}
```

### 3. Add sync() method

```ts
sync: async () => {
  // Single transaction for all buffered data
  await db.transaction(async (tx) => {
    for (const [key, { siteId, range, data }] of buffer.pages) {
      await insertPages(tx, siteId, data)
    }
    for (const [key, { siteId, range, data }] of buffer.keywords) {
      await insertKeywords(tx, siteId, data)
    }
    // ... countries, devices
  })

  buffer.pages.clear()
  buffer.keywords.clear()
  // ...
}
```

### 4. Add discard() method

```ts
discard: () => {
  buffer.pages.clear()
  buffer.keywords.clear()
  buffer.countries.clear()
  buffer.devices.clear()
}
```

### 5. Update DataProvider interface

```ts
interface DataProvider {
  source: DataSource

  // Existing query methods...

  // New sync methods (optional - only on hybrid)
  sync?: () => Promise<void>
  discard?: () => void
  pending?: () => number // count of buffered items
}
```

### 6. Add insert functions to @gscdump/db

Currently sync functions fetch + insert. Need separate insert-only functions:

```ts
// New in @gscdump/db
export async function insertPages(db: GscDb, siteId: number, rows: PageInsert[]): Promise<void>
export async function insertKeywords(db: GscDb, siteId: number, rows: KeywordInsert[]): Promise<void>
export async function insertCountries(db: GscDb, siteId: number, rows: CountryInsert[]): Promise<void>
export async function insertDevices(db: GscDb, siteId: number, rows: DeviceInsert[]): Promise<void>
```

Or refactor existing sync functions to accept pre-fetched data:
```ts
export async function syncPages(db: GscDb, siteId: number, data: PageData[]): Promise<void>
// Instead of
export async function syncPages(db: GscDb, client: Client, siteId: number, ...): Promise<void>
```

## Files to Change

1. **packages/db/src/sync.ts** - Extract insert logic from sync functions
2. **packages/query/src/hybrid-provider.ts** - Add buffering, sync(), discard()
3. **packages/query/src/types.ts** - Add sync/discard to DataProvider interface

## Edge Cases

- Multiple queries for same site/range → dedupe in buffer
- Query after sync → hits DB (data now persisted)
- Error during sync → transaction rollback, buffer intact for retry
- Provider disposed without sync → data lost (intentional)

## Migration

- API provider: unchanged (no sync methods)
- DB provider: unchanged (no sync methods)
- Hybrid provider: new behavior, sync() required to persist

CLI/MCP need updates to call `provider.sync()` after queries.
