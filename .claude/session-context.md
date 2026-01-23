# Session Context

Last updated: 2026-01-23 01:17

## Git State
```
Branch: main
 M .claude/session-context.md
 M ARCHITECTURE.md
 M CLAUDE.md
 M README.md
 M packages/cli/package.json
 D packages/cli/src/commands/analyze.ts
 D packages/cli/src/commands/compare.ts
 M packages/cli/src/commands/dump.ts
 D packages/cli/src/commands/indexing.ts
 M packages/cli/src/commands/mcp.ts
AM packages/cli/src/commands/query.ts
 D packages/cli/src/commands/sync.ts
 M packages/cli/src/index.ts
A  packages/cli/src/mcp/handlers/analytics.ts
A  packages/cli/src/mcp/handlers/index.ts
A  packages/cli/src/mcp/handlers/indexing.ts
A  packages/cli/src/mcp/handlers/query.ts
A  packages/cli/src/mcp/handlers/sites.ts
A  packages/cli/src/mcp/handlers/utils.ts
A  packages/cli/src/mcp/index.ts
```

## Recent Commits
```
f58a729 chore: progress
0bcdd26 chore: progress
25a0eeb chore: release v0.1.3
b409a1a fix: missing `today()` and `daysAgo()`
f005e32 chore: release v0.1.2
```

## Recently Modified
```
./packages/cli/src/commands/query.ts
./packages/cli/src/commands/mcp.ts
./packages/cli/src/mcp/index.ts
./packages/cli/src/mcp/types.ts
./packages/cli/src/mcp/server/index.ts
./packages/cli/src/mcp/handlers/index.ts
./packages/cli/src/mcp/handlers/query.ts
./packages/cli/src/mcp/handlers/analytics.ts
./packages/cli/src/mcp/handlers/utils.ts
./packages/cli/src/mcp/handlers/sites.ts
```

## Active Plan

File: /home/harlan/pkg/gscdump/.claude/plans/fix-lint-tests.md

# Plan: Fix Lint and Tests

## Status: PENDING

## Lint Issues (8 errors)

### 1. docs/API_COST_MATRIX.md (2 errors)
- Parsing errors in code blocks - likely outdated examples
- **Fix:** Delete or update the file (references old API)

### 2. packages/gscdump/src/api/period.ts (5 errors)
- 4x `antfu/consistent-chaining` - line breaks in chained calls
- 1x `unused-imports/no-unused-vars` - unused `unit` variable
- **Fix:** Run `pnpm lint:fix` + manually fix unused var

### 3. packages/gscdump/src/core/client.ts (1 error)
- Missing return type on `rawQuery` function
- **Fix:** Add explicit return type

## Test Issues (65 failures)

### Root Cause
Tests were written for OLD API that had:
- `fetchSitesWithSitemaps(auth, ...)` - auth as first param
- `fetchPagesWithComparison(auth, site, range)` - comparison functions
- `fetchKeywordsWithComparison(...)` - etc.

NEW API has:
- `fetchSitesWithSitemaps(client)` - client object
- No comparison functions (removed with db package)
- `client.query(siteUrl, builder)` - streaming queries

### Failing Test Files
1. `packages/gscdump/test/dump.test.ts` - 24 failed
2. `packages/gscdump/test/stream.test.ts` - 10 failed
3. `packages/gscdump/test/client.test.ts` - 2 failed
4. `packages/gscdump/e2e/integration.test.ts` - 6 failed
5. `packages/gscdump/e2e/comprehensive.test.ts` - 13 failed
6. `tests/exports.test.ts` - setup error
7. `tests/e2e/live.test.ts` - setup error

### Fix Strategy

**Option A: Delete obsolete tests**
- Tests for removed functions (`fetchPagesWithComparison`, etc.) - DELETE
- Tests for old signatures - DELETE
- Keep: query builder tests, operator tests, error utility tests

**Option B: Rewrite tests for new API**
- More work but better coverage
