# browser-http

Four side-by-side strategies for running `@gscdump/analysis` analyzers in
the browser against synced GSC data:

| Mode | Shape | Query latency* | When to use |
|---|---|---|---|
| `http` (engine per-file) | `read_parquet([1 URL per day])` | ~20 ms warm / ~120 ms cold | Fine at <100 files. Native engine + HTTP adapter. |
| `snapshot` | One `.duckdb` file pre-downloaded and `ATTACH`ed | ~5 ms | Small datasets, offline-capable. |
| `snapshot-url` | `ATTACH 'https://.../snapshot.duckdb'` via httpfs | ~5 ms | Large snapshots; only bytes the query needs travel. |
| `hotcold` | N monthly cold `.duckdb` + 1 hot `.duckdb`, `ATTACH`ed and UNIONed | ~5 ms | Production dashboard shape — incremental rebuild ≪ full rebuild. |
| `parquet` | `CREATE VIEW … AS SELECT * FROM read_parquet([N URLs])` | ~4 s at 501 URLs | Post-compaction path with ~50 URLs: extrapolates to ~400 ms. |

*measured on Apr 2026 against a mixed dataset of 2,423 partitions / 3.3 MB
of `.duckdb` / 501 parquet URLs, from localhost.

## Two ways to run

### Against your real R2 bucket (default)

`proxy.mjs` signs R2 reads with env-var creds and exposes them at the
origin. `manifest.json` is built live from an R2 `LIST` under
`u_<GSCDUMP_USER_ID>/<GSCDUMP_SITE_ID>/`.

```sh
# .env needs: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
#             R2_BUCKET, GSCDUMP_USER_ID, GSCDUMP_SITE_ID
node examples/browser-http/proxy.mjs
# → http://localhost:8081/?user=<R2 userId>
```

### Against a local `gscdump sync` dump

Drop your local data under `_served/` and pass `?base=./_served&user=local`.
The proxy isn't needed but any static server works:

```sh
mkdir -p examples/browser-http/_served
cp -r ~/.gscdump/data/manifest.json ~/.gscdump/data/u_local \
     examples/browser-http/_served/
cd examples/browser-http
python3 -m http.server 8081
# → http://localhost:8081/?base=./_served&user=local
```

## Rebuilding the bundle / snapshots

The browser imports from `bundle.mjs` (engine + adapters + analyzer
dispatcher, bundled by esbuild). Hot/cold snapshots come from
`snapshot.mjs`.

```sh
# rebuild the bundle after package source changes
pnpm --filter gscdump --filter @gscdump/analysis run build
./node_modules/.bin/esbuild examples/browser-http/browser-entry.mjs \
  --bundle --format=esm --platform=browser \
  --outfile=examples/browser-http/bundle.mjs \
  --alias:gscdump/analytics=./packages/gscdump/dist/analytics/index.mjs \
  --alias:gscdump/analytics/http=./packages/gscdump/dist/analytics/adapters/http.mjs \
  --alias:@gscdump/engine-duckdb-node=./packages/engine-duckdb-node/dist/index.mjs \
  --alias:@gscdump/engine-wasm=./packages/analysis/dist/browser/index.mjs \
  --alias:gscdump=./packages/gscdump/dist/index.mjs

# build hot/cold snapshots (requires the proxy running on :8081)
node examples/browser-http/snapshot.mjs          # incremental (cold reuses)
node examples/browser-http/snapshot.mjs --force  # full rebuild
```

Nightly cost on a typical dataset: ~800 ms (only `hot.duckdb` rewrites).
Month rollover adds ~1–2 s for one new `cold-YYYY-MM.duckdb`.

## Pointing at production R2 directly (no proxy)

Edit the `CONFIG` in `index.html` to use absolute R2 URLs:

```js
const CONFIG = {
  baseUrl: 'https://<bucket>.r2.cloudflarestorage.com', // or a signed Worker
  manifestUrl: 'https://api.gscdump.com/u/<id>/manifest.json',
  userId: '<user-id>',
}
```

Requirements:
- **CORS** on the R2 bucket allowing `GET` + `Range` from the dashboard
  origin, plus `Access-Control-Expose-Headers: Content-Range,
  Accept-Ranges, Content-Length`.
- **Object keys** match `gscdump sync` output:
  `u_<userId>/<siteId>/<table>/daily/<date>__v<ts>.parquet`.
- **Manifest** served as JSON matching
  `{ version: 1, entries: ManifestEntry[], watermarks?: Watermark[] }` —
  publish a snapshot from D1 (or wherever your authoritative manifest
  lives).
- **Cache headers** — immutable parquets and cold `.duckdb` files should
  be `Cache-Control: public, max-age=31536000, immutable`. The `hot.duckdb`
  needs `max-age=60` or `must-revalidate`. Parquet range responses benefit
  from long-cache; DuckDB httpfs reuses the browser HTTP cache on repeat
  range reads.

For production sign Parquet URLs per-session via a Worker (`signUrl`
option on `createHttpDataSource`) so each user only sees their own
prefix.

## Files

- `index.html` — demo UI with mode toggle.
- `bundle.mjs` — esbuild output (generated; gitignored).
- `browser-entry.mjs` — bundle entry point re-exporting package APIs.
- `proxy.mjs` — Node HTTP proxy that signs R2 reads + builds a live
  manifest from `LIST`. Not for production — a Worker does this shape.
- `snapshot.mjs` — hot/cold snapshot builder. Writes under `_snapshots/`.
- `_snapshots/` — generated `.duckdb` files + `index.json` (gitignored).
- `_served/` — optional local data dump for `?base=./_served` mode
  (gitignored).
