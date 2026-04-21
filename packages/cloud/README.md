# @gscdump/cloud

**Frozen.** Not under active development. Tests and build pass; no new features.

Cloud SDK + `gscdump-cloud` bin. Exposes `register`, `unregister`, `indexing`, `sync`, and `sitemaps` subcommands that were part of the old cloud-mode CLI, plus `createCloudDriver` and the `Cloud*` type surface for consumers who need them.

## Revival trigger

Un-freeze when **gscdump.com's web app** imports runtime code from this package (not just shared types). That's the concrete signal that the cloud path is back in active development — at which point:

- Drop `"private": true` from `package.json` if publishing.
- Update the dependency graph note in `PIVOT.md` / `NEXT_STEPS.md`.
- Re-evaluate whether `@gscdump/cli` should depend on `@gscdump/cloud` again (PIVOT #9 removed that edge).

Until then, treat this package as archival.
