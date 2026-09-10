# CLI charts

The CLI uses one chart kit for human output.
Charts keep exact values, metric units, and period labels visible.
JSON and CSV retain their existing payloads.

## Commands

| Command | Human output |
| --- | --- |
| `gscdump analyze trends` | Weekly sparklines, growth, and average position. |
| `gscdump analyze movers` | Click changes around zero, current values, and previous values. |
| `gscdump analyze brand --brand-terms example` | Brand click share and returned rows. |
| `gscdump analyze seasonality` | Monthly volume and available-history warnings. |
| Other Analyzers | Aligned tables with consistent metric units. |
| `gscdump report movers` | Section coverage, click changes, and metric summaries. |
| Other Reports | Section coverage and formatted findings. |
| `gscdump store stats` | Live bytes by table, counts, and sync watermarks. |
| `gscdump query --format table` | A human table, plus ranked bars or daily sparklines for supported dimensions. |

Query output still defaults to JSON, or your saved format.
Use an explicit table format to see query charts:

```sh
gscdump query --site sc-domain:example.com --dimensions page --format table
gscdump query --site sc-domain:example.com --dimensions date --format table
```

Use `--json` for Analyzer or Report JSON.
Use `--format csv` for Analyzer or query CSV.
Use `--output results.txt --format table` to save a plain query table.
Raw SQL supports `--format table` without selecting a chart.

## Reading charts

- Cyan identifies the primary series.
- Green and red mark improvement and deterioration. Signs also show direction.
- Share categories carry no success meaning.
- Bars start at zero. A full bar is the largest displayed value.
- Diverging bars share a symmetric scale around zero.
- Sparklines use a separate scale for each row. Compare their shape.
- Each time column represents the same period across rows.
- `·` marks missing series data. It does not mean zero.
- Long series combine consecutive periods. The output states the number of periods per cell.
- A combined cell stays missing if any contributing period lacks data.
- Exact values remain beside charts.

A constant positive sparkline uses the middle glyph.
A zero sparkline uses the lowest glyph and displays an exact zero total.

## Metric units

| Metric | Example |
| --- | --- |
| Clicks | `12,480` |
| CTR | `1.20%` |
| CTR change | `+0.52 pp` |
| Click change | `+120 (+20.0%)` |
| Average position | `8.4` |
| Position change | `improved 1.3` |
| Store size | `1.00 MiB` |

`pp` means percentage points.
A lower average position means improvement.
A zero previous value has no percentage change. The output states the zero baseline.
Unknown values display `n/a`.

## Data limits

Brand share covers the returned rows used by the Analyzer.
It is not necessarily the complete Site population.
Query chart totals also cover returned rows only.
Reports keep their existing Section limits and show known omitted counts.

Missing dates stay visible.
A short monthly history cannot establish an annual pattern.
The CLI warns when fewer than twelve months are available.
Selected partial months are also identified.
Reports preserve partial coverage when a step fails.

## Terminal support

Tables stack their fields when columns do not fit.
Chart labels can shorten. JSON and CSV preserve the original identifiers.
The renderer measures Unicode terminal cells and preserves grapheme boundaries.

`--no-color` and nonempty `NO_COLOR` remove color while keeping Unicode charts.
`TERM=dumb` selects ASCII chart symbols and removes color.
ASCII sparklines use levels `1` through `8`; `?` marks missing data.
Piped output stays static. Diagnostics use stderr.
File output contains no ANSI color codes.

## Extending the kit

The CLI owns the renderers in `packages/cli/src/render/`.
Renderers receive data and terminal capabilities, then return strings.
Commands own data access and writing to stdout.
Add explicit metric definitions before introducing a chart for another Analyzer.
Test its exported behavior with missing values, zero baselines, and narrow output.
