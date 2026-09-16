# Performance measurements

Every merged commit is measured against its parent, in one CI job, on one machine, within seconds.
Machine class, CPU model, thermal state, and noisy neighbours hit both sides equally, so they cancel in the delta.
A number compared against another machine's number cannot be repaired by statistics, so nothing here does that.

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

`paired` is false when the commit changed `pnpm-lock.yaml`, because both sides then build from one lockfile and the comparison is invalid. Drop those.

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
