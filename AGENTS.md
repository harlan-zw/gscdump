# AGENTS.md

Use [ARCHITECTURE.md](ARCHITECTURE.md) for package boundaries and [GLOSSARY.md](GLOSSARY.md) for vocabulary.
Usage lives in [README.md](README.md); planned work lives in [ROADMAP.md](ROADMAP.md).
Commands live in [package.json](package.json).

## Working Rules

- Prefer existing subpath exports over new barrels.
- Keep `gscdump` edge-safe: no `node:*`, DuckDB, or storage dependencies.
- Keep `@gscdump/sdk` framework-agnostic. Nuxt behavior belongs in `~/sites/nuxtseo.com/layers/pro/gsc`.
- Keep host-app concerns in consumers unless two consumers need them or they define a stable protocol contract.
- Use `@gscdump/contracts` for hosted wire shapes and routes, and `@gscdump/sdk` for transport.
  Use `gscdump/query` for query-builder types; do not duplicate these types in the SDK.

## Consumers

- `~/sites/gscdump.com`
- `~/sites/nuxtseo.com`

Verify external migrations in the affected consumer repositories and run their tests before declaring them complete.

Keep CLI authentication docs and [the packaged skill](packages/cli/skills/gscdump/SKILL.md) aligned with command behavior.
Refresh `~/sites/gscdump.com/public/SKILL.md` when the packaged skill changes.

## Live API Checks

For live Google API changes, run `pnpm test:e2e` with either `GSC_ACCESS_TOKEN`
or `GSC_CLIENT_ID` + `GSC_CLIENT_SECRET` + `GSC_REFRESH_TOKEN`.
Require the live tests to pass; without credentials, they skip.
