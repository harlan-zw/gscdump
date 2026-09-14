# Run an Analyzer and a Report

Use the same temporary configuration and date variables as the bounded CLI journey.
This journey syncs three tables for the requested dates.
It reads Google and writes only the temporary Store.

```sh
gscdump sync --site "$EVAL_SITE" --start "$EVAL_START" --end "$EVAL_END" --tables pages,queries,page_queries --no-rollups --json
gscdump query --site "$EVAL_SITE" --start "$EVAL_START" --end "$EVAL_END" --dimensions page,query --limit 1000 --format json
gscdump analyze striking-distance --site "$EVAL_SITE" --start "$EVAL_START" --end "$EVAL_END" --json
gscdump report opportunities --site "$EVAL_SITE" --period custom --start "$EVAL_START" --end "$EVAL_END" --json
```

The query must return real page and query rows.
The Analyzer may return no findings for a small date range.
The Report must include the Analyzer's findings and report complete coverage.
An empty finding list does not prove that the Site has no issues.
