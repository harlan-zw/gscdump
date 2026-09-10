# CLAUDE.md

This file gives repository-specific guidance for Claude Code and other coding
agents. Product/user docs live in `README.md`; architecture language lives in
`ARCHITECTURE.md` and `GLOSSARY.md`; active work lives in `ROADMAP.md`.

## Consumers

- `~/sites/gscdump.com`
- `~/sites/nuxtseo.com`

Consumer work may require changes outside this repository. Do not assume
external migrations are complete unless they have been checked in those repos
and covered by their tests.

## Project Shape

`gscdump` is a pnpm monorepo for Google Search Console and Bing data:

- `gscdump`: edge-safe REST client, typed query builder, core primitives.
- `@gscdump/engine`: Parquet/DuckDB storage, manifests, compaction, rollups,
  entity stores, analyzer/source contracts.
- `@gscdump/engine-duckdb-wasm`, `@gscdump/engine-sqlite`,
  `@gscdump/engine-gsc-api`: runtime adapters.
- `@gscdump/analysis`: analyzers and reports.
- `@gscdump/contracts`: hosted API, analytics routes, schemas, webhooks,
  realtime, lifecycle contracts.
- `@gscdump/sdk`: hosted partner and analytics HTTP clients.
- `@gscdump/cloudflare`: Cloudflare/R2 helper primitives.
- `@gscdump/lakehouse`: dataset-agnostic Iceberg catalog and dataset registry.
- `@gscdump/cli`: CLI plus the bundled MCP server (`gscdump mcp`).

## Commands

- Build: `pnpm build`
- Test all: `pnpm test`
- E2E: `pnpm test:e2e`
- Contracts: `pnpm test:contracts`
- Typecheck: `pnpm typecheck`
- Lint: `pnpm lint`

`pnpm test:e2e` passes locally without credentials, but live Google API tests
skip unless BYOK env vars are present. Treat live API features as complete only
after e2e passes with either `GSC_ACCESS_TOKEN` or
`GSC_CLIENT_ID` + `GSC_CLIENT_SECRET` + `GSC_REFRESH_TOKEN`.

## Working Rules

- Prefer existing package boundaries and subpath exports over new barrels.
- Keep `gscdump` edge-safe: no `node:*`, DuckDB, or storage dependencies in
  the core package.
- Keep `@gscdump/sdk` framework-agnostic. Nuxt behavior belongs in consumer
  layers, currently `nuxtseo.com/layers/pro/gsc`.
- Keep host-app concerns out of packages unless there is a second consumer or
  a clear stable protocol contract.
- Use `@gscdump/contracts` for hosted API wire shapes and routes.
- Use `@gscdump/sdk` clients for hosted API transport.
- Use `gscdump/query` for strict query-builder types. Hosted wire shapes come
  from `@gscdump/contracts`; the SDK does not duplicate either surface.
- The MCP server lives in `@gscdump/cli` (`src/mcp/`); there is no separate
  MCP package. Edit it through the CLI surface.
- Resolve shared cloud or local authentication before Search Engine requests. Keep local Google and Bing credentials separate.
- Public hosted calls use `@gscdump/sdk/v1`. CLI Google routes use `cloud-google.ts` and remain outside the v1 protocol.
- MCP exposes Google tools. The packaged skill covers both Google and Bing CLI commands.
- Keep CLI authentication docs and `packages/cli/skills/gscdump/SKILL.md` aligned with command behavior.
- The website publishes that skill as `~/sites/gscdump.com/public/SKILL.md`; refresh its copy with coordinated CLI changes.

## Completion Bar

For roadmap cleanup and planning, "complete" means:

1. Code is implemented.
2. Relevant tests pass.
3. Relevant e2e passes. If live Google API behavior is involved, BYOK e2e must
   run rather than skip.
