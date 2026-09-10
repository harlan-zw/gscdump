# @gscdump/cloudflare

Cloudflare helpers for server-tail queries and concurrent request deduplication.

## Install

```bash
npm install @gscdump/cloudflare
```

The package has two public subpaths and no root export.

| Subpath | Purpose |
| --- | --- |
| `@gscdump/cloudflare/server-tail` | Route queries through R2 SQL or a DuckDB service |
| `@gscdump/cloudflare/inflight-dedupe` | Share pending requests with identical keys |

## Deduplicate pending requests

```ts
import { createInflightDedupe, getHostedR2QueryKey } from '@gscdump/cloudflare/inflight-dedupe'

const requests = createInflightDedupe<string[]>()
const key = getHostedR2QueryKey({
  userId: 'u_01',
  siteId: 's_01',
  state: { dimensions: ['page'] },
})
const rows = await requests.dedupe(key, async () => ['https://example.com/docs'])
console.log(rows)
```

Concurrent calls with the same key share one promise.
After it settles, the next call runs again.
Include the authenticated user, Site, query state, and comparison inputs in the key.

## Server-tail queries

`createServerTailDispatcher` selects a configured R2 SQL or DuckDB executor.
The subpath exports the executor factories, transport helpers, SQL compilation, and typed routing errors.
Your host supplies credentials, transport, authorization, and the DuckDB service binding.

For storage contracts, see [`@gscdump/engine`](../engine/README.md).
For hosted HTTP integrations, use [`@gscdump/sdk`](../sdk/README.md).

## License

[MIT](../../LICENSE)
