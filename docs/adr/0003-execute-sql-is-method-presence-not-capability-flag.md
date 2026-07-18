# `executeSql` lives as method presence on `AnalysisQuerySource`, not as a `capabilities.executeSql` flag

The `AnalysisQuerySource` interface declares `executeSql` as an optional method. Callers (analyzer dispatcher, registry) detect availability by probing `typeof source.executeSql === 'function'` — see `packages/engine/src/source/source-types.ts:34` ("SQL execution is not a capability flag") and `packages/engine/src/analyzer/dispatch.ts:26`.

A recurring architecture-review suggestion is to promote `executeSql` to a `SourceCapabilities.executeSql: boolean` flag alongside `regex`, `multiDataset`, etc. so all routing decisions read from one shape. Don't do this.

Reasons:

1. **Method-presence is the invariant.** A flag + method pair must agree: `capabilities.executeSql === true` iff `typeof source.executeSql === 'function'`. Every factory has to maintain that coupling at construction, and consumers have to trust it. With method-presence, the invariant is enforced by the type system — there is no way to lie.
2. **No leverage at the seam.** The dispatcher checks `executeSql` once per dispatch (`dispatch.ts:46, 92`). Replacing those with `source.capabilities.executeSql` saves no lines, adds a new field to keep in sync across six source factories, and creates a class of bugs (flag set, method missing) that currently can't exist.
3. **`SourceCapabilities` describes plan-shape compatibility.** `regex`, `multiDataset`, `comparisonJoin`, `windowTotals` are planner capabilities — what plan shapes the source can answer. `executeSql` is a different axis: whether the raw-SQL escape hatch is available at all. The flag-set is correctly scoped to plan compatibility, not to "everything routing might want to know."

Don't propose this in future architecture passes. If `SourceCapabilities` ever stops being purely planner-scoped (e.g. absorbs `attachedTables`/`fileSets` into a separate "storage" sub-bag), revisit — at that point the seam might be ready for an `executeSql` flag too.
