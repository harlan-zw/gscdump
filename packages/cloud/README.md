# @gscdump/cloud

[![status: frozen](https://img.shields.io/badge/status-frozen-lightgrey)](#revival-trigger)
[![license](https://img.shields.io/github/license/harlan-zw/gscdump?color=yellow)](https://github.com/harlan-zw/gscdump/blob/main/LICENSE)

> Cloud SDK + cloud CLI for Google Search Console. **Frozen — not under active development.** Tests and build pass; no new features.

Cloud SDK + `gscdump-cloud` bin. Exposes `register`, `unregister`, `indexing`, `sync`, and `sitemaps` subcommands that were part of the old cloud-mode CLI, plus `createCloudDriver` and the `Cloud*` type surface for consumers who need them.

Marked `"private": true` — not published to npm. See revival trigger below.

## Revival trigger

Un-freeze when **gscdump.com's web app** imports runtime code from this package (not just shared types). That's the concrete signal that the cloud path is back in active development — at which point:

- Drop `"private": true` from `package.json` if publishing.
- Update the dependency graph note in `PIVOT.md` / `NEXT_STEPS.md`.
- Re-evaluate whether `@gscdump/cli` should depend on `@gscdump/cloud` again (PIVOT #9 removed that edge).

Until then, treat this package as archival.

## Related

- [`gscdump`](../gscdump) — REST client + query builder.
- [`@gscdump/analysis`](../analysis) — SEO analyzers consumed by the cloud bin.
- [`@gscdump/cli`](../cli) — Active CLI; the supported entry point for end users.

## License

[MIT](../../LICENSE)
