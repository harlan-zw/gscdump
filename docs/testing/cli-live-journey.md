# Run a bounded CLI journey

Use a Google Site with traffic and an existing local Google connection.
Set `EVAL_SITE`, `EVAL_START`, and `EVAL_END` to the Site and finalized dates.
Use a fresh CLI config directory with `dataDir` pointing to an empty temporary Store.
Keep the date range within seven days.
These commands read Google and write only the temporary Store and export directory.

```sh
gscdump auth status --json
gscdump sync --site "$EVAL_SITE" --start "$EVAL_START" --end "$EVAL_END" --tables pages --no-rollups --json
gscdump sync --site "$EVAL_SITE" --status --json
gscdump query --site "$EVAL_SITE" --start "$EVAL_START" --end "$EVAL_END" --dimensions page --limit 1000 --format json --quiet
gscdump query --live --site "$EVAL_SITE" --start "$EVAL_START" --end "$EVAL_END" --dimensions page --limit 1000 --format json --quiet
gscdump dump --site "$EVAL_SITE" --tables pages --format json --out ./export --json
```

Compare stored and live page metrics for the same dates.
Group live URLs by pathname, matching Store ingestion.
Reopen the exported JSON and compare page clicks and impressions with the stored results.
If no rows exist, this journey cannot verify a data round trip.
