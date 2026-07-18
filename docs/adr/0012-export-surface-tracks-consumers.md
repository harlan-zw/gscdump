# ADR-0012 — Export surface tracks the two consumers

## Status

Accepted

## Context

The package set accumulated subpath exports faster than consumers used them.
An audit of every `package.json` `exports` map against the only two real
consumers — `gscdump.com` and `nuxtseo.com` — found three classes of waste:

1. **Dead subpaths** with zero importers anywhere (e.g. `gscdump/driver`,
   `gscdump/onboarding`, `@gscdump/engine/schedule`, `@gscdump/analysis/query`).
2. **Internal-only subpaths** advertised as public API but imported only by
   sibling workspace packages (e.g. `@gscdump/engine/planner`,
   `./sql-fragments`, `./scope`, `./arrow`). These leak engine internals into
   the published contract.
3. **Whole packages** kept alive past their usefulness: `@gscdump/cloud` (an
   orphan `protocol.ts`, no `package.json`, zero importers) and `@gscdump/mcp`
   (a `private: true` package whose only consumer was our own CLI).

## Decision

**The published export surface is defined by demand from the two consumers.**
A subpath exists only if `gscdump.com` or `nuxtseo.com` imports it, or it is a
distinct, documented public concept. Internal cross-package wiring is not a
reason to keep a subpath public; it is a reason to import via a private path.
Consumer code may be migrated when an export is collapsed.

Concrete actions taken in this pass:

- **Deleted `@gscdump/cloud`** entirely (orphan stub, no consumers).
- **Deleted `@gscdump/mcp`**; its server now lives inside `@gscdump/cli`
  (`src/mcp/`), reached through `gscdump mcp`. This **overrides the former
  "MCP package is frozen" rule** — a frozen package with a single internal
  consumer is better absorbed than maintained as a separate publish target.
- **Dropped dead subpaths**: `gscdump/driver`, `gscdump/onboarding`,
  `@gscdump/engine/schedule`, `@gscdump/analysis/query`. The underlying modules
  remain where still used internally; only the export keys were removed.

## Consequences

- Removing or narrowing a published subpath is a SemVer-visible event. Because
  both consumers migrate in lockstep with this repo, no compatibility shims are
  needed; the change is coordinated, not breaking-in-the-wild.
- `@gscdump/engine/vendor/hysnappy` looks unused by import statements but MUST
  stay: `gscdump.com/nuxt.config.ts` aliases `hysnappy` to the emitted
  `dist/vendor/hysnappy-purejs.mjs`. The build must keep emitting that file.
- Future architecture passes should re-run the consumer-import audit rather than
  assume internal usage justifies a public export.
