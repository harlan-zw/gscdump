# Run an Analyzer and a Report

Use the same temporary configuration and date variables as the bounded CLI journey.
This journey syncs three tables for the requested dates.
It reads Google and writes only the temporary Store.

The `opportunities` Report composes several Analyzers, including
`query-migration`. That Analyzer always compares against the period
immediately before the requested window, the same length, even when the
Report's own default comparison is `none`. Sync that comparison window for
`page_queries` too, or the Report stops with `STORE_RANGE_NOT_COVERED`.

```sh
gscdump sync --site "$EVAL_SITE" --start "$(date -u -d "$EVAL_START -$(( ($(date -u -d "$EVAL_END" +%s) - $(date -u -d "$EVAL_START" +%s)) / 86400 + 1 )) day" +%Y-%m-%d)" --end "$EVAL_END" --tables pages,queries,page_queries --no-rollups --json
gscdump query --site "$EVAL_SITE" --start "$EVAL_START" --end "$EVAL_END" --dimensions page,query --limit 1000 --format json
gscdump analyze striking-distance --site "$EVAL_SITE" --start "$EVAL_START" --end "$EVAL_END" --json
gscdump report opportunities --site "$EVAL_SITE" --period custom --start "$EVAL_START" --end "$EVAL_END" --json
```

The query must return real page and query rows.
The Analyzer may return no findings for a small date range.
The Report must include the Analyzer's findings and report complete coverage.
An empty finding list does not prove that the Site has no issues.
