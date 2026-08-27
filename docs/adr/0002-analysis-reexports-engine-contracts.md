# `@gscdump/analysis` re-exports the engine contract layer

The contract types/dispatcher (`Analyzer`, `defineAnalyzer`, `runAnalyzerFromSource`, `BuildContext`, `AnalysisQuerySource`, `RequiredCapability`, period helpers, report contracts) live in `@gscdump/engine` subpaths but are re-exported from `@gscdump/analysis` (`packages/analysis/src/index.ts` lines 95–194). The deletion test against this monorepo says nothing concentrates: every caller could import from `@gscdump/engine/analyzer`, `/period`, `/source`, etc. directly.

We keep the re-exports anyway. Reasons:

1. **Public-API stability for external consumers.** `gscdump.com` and `nuxtseo.com` depend on `@gscdump/analysis` and import contracts via the barrel today; deleting the re-exports would force them to add `@gscdump/engine` to their dependency graph and rewrite imports across dozens of files. The barrel is the documented "one-import" surface.
2. **Single conceptual seam.** Consumers reason about analysis as one package: instances + contracts + dispatcher together. Splitting the imports leaks the engine extraction (an internal layout decision) into every caller.
3. **No locality cost.** The re-exports add ~100 lines to `analysis/src/index.ts` but no logic; type drift is impossible because the engine is the source of truth.

Don't propose deleting these re-exports in future architecture passes. If `@gscdump/engine` itself absorbs the analyzer instances (currently it doesn't — instances stay in analysis to keep engine slim for edge runtimes), revisit.
