# browser-attach

Proof-of-concept: the browser attaches a `.duckdb` file produced by `gscdump store export` and runs SQL directly against it, fully client-side, no backend.

## How it works

1. `gscdump store export --out ./gscdump.duckdb --force` packs every live Parquet partition into one DuckDB database file, one table per schema (pages, keywords, countries, devices, page_keywords).
2. The browser loads `@duckdb/duckdb-wasm` from jsDelivr.
3. The user picks the `.duckdb` file; it's registered as a virtual-FS buffer.
4. `ATTACH 'gsc.duckdb' AS gsc (READ_ONLY)` exposes every table.
5. Arbitrary SQL runs locally in the browser. No fetches per query.

## Run

```sh
# From gscdump repo root — pack your synced data
gscdump store export --out ./examples/browser-attach/gscdump.duckdb --force

# Any static server works
cd examples/browser-attach
python3 -m http.server 8080
# → http://localhost:8080/
```

Pick the `.duckdb` file through the UI file picker (same-origin, no CORS needed).

## Why this shape

- **Zero lock-in.** The `.duckdb` file is a portable DuckDB database. Any DuckDB client reads it.
- **Zero per-query cost.** All compute is in the user's browser after the ~5 MB WASM loads once.
- **One-file distribution.** No manifest protocol, no signed-URL fan-out — you hand over one URL/file.
- **Scales as far as the browser can.** For datasets over a few hundred MB you want a server-side execution path (MotherDuck, Hyperdrive, etc.) instead.

## Running analyzers in the browser

The demo also includes a "Run an analyzer" panel that exercises
`@gscdump/analysis`'s DuckDB analyzers directly in the browser. The same SQL
that the server-side `analyzeWithDuckDB` runs is rewritten to read from
`gsc.<table>` instead of `read_parquet([...])`, then executed against the
attached DuckDB file — identical results, zero network.

### Rebuilding `analyzers.mjs`

The demo ships a pre-built bundle at `analyzers.mjs`. Regenerate after source
changes:

```sh
pnpm --filter gscdump --filter @gscdump/analysis run build
./node_modules/.bin/esbuild packages/analysis/dist/duckdb/index.mjs \
  --bundle --format=esm --platform=browser \
  --outfile=examples/browser-attach/analyzers.mjs \
  --alias:gscdump/analytics=./packages/gscdump/dist/analytics/index.mjs
```

## Production notes

- For CDN serving: host `gscdump.duckdb` and do `ATTACH 'https://cdn.example.com/gscdump.duckdb' AS gsc (READ_ONLY)`. DuckDB-WASM issues HTTP range requests so only the bytes the query needs are fetched.
- For per-user isolation: publish `u_<id>.duckdb` per user, signed-URL it with a short TTL, and attach that URL.
