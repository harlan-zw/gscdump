# ADR-0004 — Analyzer registration is a build-time path, not a Nuxt runtime hook

## Status

Superseded

Superseded on 2026-08-28. Both production consumers now own their Nuxt
integration. ADR-0012 governs removal of the unused published package.

## Context

`@gscdump/nuxt` needs hosts to wire a `GscAnalyzerDefinition[]`
through `$gscAnalyzers` so panels, action priority, and the insights cards can
resolve definitions by id.

Two shapes were considered for the seam:

1. **Build-time path option** (current). `nuxt.config.ts` sets
   `gscdumpAnalytics: { analyzers: '~/gscAnalyzers' }` and `module.ts`
   generates a plugin that imports the host's array and provides it.
2. **Nuxt runtime hook** (e.g. `gscdump-analytics:analyzers`) that other
   modules / plugins could push entries into at runtime.

Shape (2) is more flexible: any module could contribute analyzers without the
host knowing. Shape (1) requires every analyzer to be reachable from a single
host-owned file.

## Decision

Use shape (1): a single build-time path option, no runtime hook.

## Consequences / rationale

- **Treeshaking honesty.** The host's `gscAnalyzers.ts` lazy-imports each
  bespoke panel via `defineAsyncComponent`. With a static import path, the
  bundler can split panel code per route and DCE unused analyzers. A runtime
  hook forces every contributor to register eagerly, dragging panel code
  into the initial bundle whether or not the host uses it.

- **Deterministic plugin order.** `addPluginTemplate` runs after the layer's
  `analytics.ts` plugin without race conditions. A runtime hook would have to
  fire in some plugin's `setup()`, which races with consumer plugins that
  also touch `$gsc*` providers.

- **Zero second adapter.** Both known consumers (`examples/nuxt-dashboard`
  and gscdump.com) own their full `ANALYZERS` array. No external pack
  publishes analyzers as a Nuxt module. A hook would be one adapter
  pretending to be a seam.

## When to revisit

Reopen when a third-party module wants to ship analyzers independently of the
host's array — at that point treeshaking trade-offs need to be weighed against
the contributor experience.
