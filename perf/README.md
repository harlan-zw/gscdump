# Performance measurements

A pull request gets a comment. Every merged commit gets a stored measurement.
Both are the same paired comparison, in one CI job, on one machine, within seconds.
Machine class, CPU model, thermal state, and noisy neighbours hit both sides equally, so they cancel in the delta.
A number compared against another machine's number cannot be repaired by statistics, so nothing here does that.

## The three workflows

| Workflow | Runs on | Does |
| --- | --- | --- |
| `Perf Pull Request` | a pull request | measures the head against the base, uploads the report, holds no write access |
| `Perf Comment` | after `Perf Pull Request` | checks that report against the workflow run, then posts or updates one comment |
| `Perf` | a push to `main` | measures the commit against its parent and stores it on `refs/notes/perf` |

The measuring job and the commenting job are split on purpose. A pull request from a fork runs its own code, so that job gets no token. The comment job holds the write access and never runs repository code. It checks the pull request number, the head commit, the file size, and the first line of the report before it trusts any of it.

Neither pull request workflow is a required check. Neither blocks a merge.

## Reading a measurement

```bash
git fetch origin 'refs/notes/perf:refs/notes/perf'
git notes --ref=perf show <commit>
```

Each benchmark reports three sides:

| Field | Means |
| --- | --- |
| `head` | the commit under measurement |
| `parent` | its parent, built from the same lockfile |
| `control` | the head build measured a second time |

`deltaPercent` is head against parent. `controlPercent` is head against itself.

**The control is the point.** It says how large a difference this machine invented on its own, in this same job, for this same case.
A delta no larger than the control says nothing.
Measured on an idle laptop the control sits near 1%. On a loaded machine it reaches 3%.
One control is one sample of the noise, so the harness reports both numbers and judges neither.

`dependenciesChanged` is true when the commit moved `pnpm-lock.yaml`. Each side installs from its own lockfile, so the comparison still holds. It is there to say where a delta may have come from: a dependency, rather than this repository's own code.

`verified` is false when the two sides produced different output. A faster revision that returns different bytes is a defect, never a win.

## Adding a benchmark

Add an entry to `benchmarks.json` and a case file under `scripts/perf/cases/`.

A case file answers two commands and prints one JSON line:

```bash
node scripts/perf/cases/<name>.mjs prepare --root <checkout> --fixtures <dir>
node scripts/perf/cases/<name>.mjs sample  --root <checkout> --fixtures <dir>
```

`prepare` writes fixtures and runs once, against this revision only, so both sides read identical bytes.
`sample` prints `{"value": <number>, "checksum": "<string>"}`. Keep fixture work and hashing outside the measured span.

Resolve the built entry through the checkout's own `package.json` exports, never a hardcoded `dist` path. A revision that moves its output is still measured that way.

Prefer a `count` benchmark over a `time` one wherever the question allows it. A count carries no noise at all: `engine/dist-bytes` returns the same number every run.

## The gate

`scripts/perf/report.mjs` decides what the comment calls a change.

A timed benchmark must clear twice the noise that same run measured, or 5%, whichever is larger. So the same 8% slowdown is a regression on a quiet runner and says nothing on a busy one, which is the honest answer in both cases.

A count benchmark has no noise, so any movement counts.

A benchmark whose two sides produced different output is reported as unusable and never as a win.
