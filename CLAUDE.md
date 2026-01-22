# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## GSCDump

Monorepo for Google Search Console data extraction. Core library, CLI, and database persistence.

## Monorepo Structure

```
gscdump/
├── packages/
│   ├── gscdump/          # Core library - GSC API wrapper
│   ├── cli/              # @gscdump/cli - Command-line interface
│   └── db/               # @gscdump/db - SQLite persistence with Drizzle
└── pnpm-workspace.yaml   # Workspace config with catalogs
```

Web app lives separately at https://github.com/harlan-zw/gscdump.com

## Build & Development

- **Build all**: `pnpm build`
- **Dev all**: `pnpm dev`
- **Test**: `pnpm test`
- **Lint**: `pnpm lint` / `pnpm lint:fix`
- **Typecheck**: `pnpm typecheck`

## Key Packages

### gscdump (Core)
GSC API wrapper. Pure functions, no persistence. Located at `packages/gscdump/src/`.

Key exports: `fetchSites`, `fetchPages`, `fetchKeywordsWithComparison`, `fetchPagesWithComparison`, `queryRecursive`, `createQueryBody`

### @gscdump/cli
CLI built with citty. Located at `packages/cli/src/`.

Commands: `gscdump init`, `gscdump dump`, `gscdump sync`, `gscdump compare`, `gscdump sites`, `gscdump sitemaps`, `gscdump index`, `gscdump inspect`, `gscdump auth`, `gscdump config`

### @gscdump/db
SQLite persistence with Drizzle ORM. Located at `packages/db/src/`.

Key exports: `syncSites`, `syncPages`, `syncKeywords`, `queryPagesWithComparison` (DB-backed API queries)

## Code Patterns

- **Functional**: Use functions, not classes
- **Error handling**: Use `.catch()` on promises, never try/catch
- **No backwards compat**: Delete unused code freely
- **ESM only**: All packages use `"type": "module"`
- **pnpm catalogs**: Dependencies versioned in `pnpm-workspace.yaml`

## Metric Storage (DB)

Floats stored as integers for precision:
- `ctr`: stored as `ctr * 10000`
- `position`: stored as `position * 100`

## IMPORTANT: API vs DB Pagination

**GSC API does NOT support offset/limit pagination.**

The comparison functions (`fetchPagesWithComparison`, `fetchKeywordsWithComparison`) are for **analysis**, not paginated display:

```ts
// ❌ WRONG - rowLimit is max rows, not page size. offset NOT supported.
fetchKeywordsWithComparison(client, siteUrl, { rowLimit: 50 })

// ✅ CORRECT - Fetch top N, paginate client-side
const data = await fetchKeywordsWithComparison(client, siteUrl, {
  period: { start, end },
  rowLimit: 100,
})
const page = data.current.slice(offset, offset + pageSize)
```

**For server-side pagination, use DB provider** (requires `gscdump sync` first).

See `docs/API_COST_MATRIX.md` for full API cost breakdown.

See `ARCHITECTURE.md` for detailed documentation.
