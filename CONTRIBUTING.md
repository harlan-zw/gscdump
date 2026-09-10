# Contributing

Use Node.js 22 or newer and the pnpm version declared in `package.json`.
Install dependencies with `pnpm install --frozen-lockfile`.

## Choose the package

| Change | Package |
| --- | --- |
| Google or Bing requests and typed queries | `gscdump` |
| Parquet storage, sync primitives, and Source contracts | `@gscdump/engine` |
| Live Google API Source | `@gscdump/engine-gsc-api` |
| Browser or SQLite execution | `@gscdump/engine-duckdb-wasm`, `@gscdump/engine-sqlite` |
| Analyzers and Reports | `@gscdump/analysis` |
| CLI commands and MCP | `@gscdump/cli` |
| Hosted wire contracts and HTTP clients | `@gscdump/contracts`, `@gscdump/sdk` |
| Iceberg catalogs and Cloudflare helpers | `@gscdump/lakehouse`, `@gscdump/cloudflare` |

Read [GLOSSARY.md](./GLOSSARY.md) before changing product terms.
Read [ARCHITECTURE.md](./ARCHITECTURE.md) and relevant [decisions](./docs/adr/) before changing package boundaries.

## Develop and check

```bash
# Build the published packages
pnpm --filter './packages/*' run build

# Run a focused suite
pnpm --filter @gscdump/cli exec vitest run test/commands

# Check types, lint, and unit tests
pnpm typecheck
pnpm lint
pnpm test

# Install Chromium for browser checks
pnpm --filter @gscdump/engine-duckdb-wasm exec playwright install chromium

# Run package, installation, browser, and Workers checks
pnpm check:release
```

`pnpm test:packed` installs release tarballs in a temporary directory outside the workspace.
It tests Report discovery, an explained Report, sync, repeated sync, and a stored query.
Its Google responses are fixtures. It makes no Google API requests.

If you fix a bug, first write a failing test through the exported behavior.
Assert results or boundary effects. Avoid assertions about source text or private module structure.

The Nuxt example has a separate dependency tree and setup step:

```bash
pnpm --filter @gscdump/example-nuxt-dashboard exec nuxt prepare
pnpm test:e2e
```

Check the example's [README](./examples/nuxt-dashboard/README.md) for its supported scope.

## Live Google checks

Use your own credentials and a Site with recent traffic.
These tests read Google data and write only temporary local files.

```bash
export GSC_CLIENT_ID=...
export GSC_CLIENT_SECRET=...
export GSC_REFRESH_TOKEN=...
export GSC_SITE_URL=sc-domain:example.com
pnpm test:live
```

`GSC_ACCESS_TOKEN` also works. `GOOGLE_*` credential names remain accepted.
The command fails when credentials are missing.
The pipeline test fails when no sampled Site returns data.
Ordinary `pnpm test:e2e` still skips live cases without credentials.

## Submit a pull request

Explain the problem and resulting behavior.
Include a small reproduction for a bug.
Use a Conventional Commit title, such as `fix(cli): preserve completed sync data`.

All pull requests run on isolated GitHub-hosted runners.
The required `test` check also completes for documentation changes, with package checks skipped.
Main and release jobs also use GitHub-hosted runners.

If you report a bug, include the package version, Node.js version, operating system, command, and redacted error.
Use [SECURITY.md](./SECURITY.md) for vulnerabilities.
