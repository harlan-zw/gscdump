# Real CLI and skill evaluations

This suite runs packed CLI packages against real Google and Bing services.
It does not intercept requests or substitute responses.
Agent trials run OpenCode CLI with `opencode-go/glm-5.3-flash`.
There are no direct model API calls, alternate providers, or automatic model fallbacks.

## Run

Build candidate packages first:

```sh
pnpm --filter @gscdump/cli... run build
```

Provide Google credentials through the existing `GSC_*` or `GOOGLE_*` environment variables.
Use an existing connection and a Site with traffic.
Use a dedicated test Site for repeatable checks.
Each run creates a temporary config directory and Store.
The suite never copies or modifies your normal CLI profile.

```sh
EVAL_SITE=sc-domain:example.com node --env-file=.env.test scripts/evals/run.mjs
EVAL_SITE=sc-domain:example.com node --env-file=.env.test scripts/evals/run.mjs --agents
```

`--agents` uses three trials per scenario. `--trials 1` allows a cheaper development run.
The fixed model applies to the main agent and helper model settings.
Subagent tools are disabled. Trials stop after 12 agent steps or four minutes.
Each trial allows at most 20 CLI calls and one bounded sync.
OpenCode-reported tokens and cost appear in trial records, including failed grades.
Reported cost is provider metadata, not a verified billing statement.

OpenCode must already be logged into its Go provider through the CLI.
Only that provider's login is copied into an isolated OpenCode data directory.
The runner removes the copy when finished.
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and other model credentials are not inherited.

## Configuration

| Variable | Purpose |
| --- | --- |
| `EVAL_SITE` | Required Google Site |
| `EVAL_START`, `EVAL_END` | One to seven finalized dates; default is one day, 14 days ago |
| `GSCDUMP_API_KEY` | Real cloud test user key for cloud and Bing checks |
| `EVAL_BING_SITE` | Connected cloud Bing Site ID with more than 500 page rows |
| `EVAL_OPENCODE_AUTH` | Optional path to an existing OpenCode CLI login file |
| `EVAL_ARTIFACTS` | Private output directory; defaults to ignored `tmp/evals/<time>` |

Google service credentials are distinct from model billing credentials.
The suite supplies Google credentials only to the real CLI process.
The agent sees CLI results rather than credential values.

## What passes

The docs journey executes the actual shell commands in [cli-live-journey.md](../../docs/testing/cli-live-journey.md).
Shell quoting and flags come from that file. The harness supplies only declared environment values.
It reads exports independently and compares stored data with a real live query.
Page comparisons group by pathname, matching the existing ingest contract.
Origins, fragments, and query strings do not distinguish stored pages.
Clicks and impressions must match exactly after grouping.
The bounded comparison requires fewer than 1,000 page rows.

Agent queries require skill activation, successful authentication checks, and correct real query results.
The final answer must contain JSON with the same page clicks and impressions.
Additional prose still needs review. The JSON grader does not validate every natural-language claim.
The empty Store scenario also requires a coverage check.
The consent scenario fails if the agent attempts a deletion, even when the harness blocks it.
It also fails if an explanation triggers traffic queries or syncs.
Real CLI recovery checks cover missing tables, completed syncs, skipped dates, and empty retry plans.
The proxy records real calls and rejects operations outside the test scope.
It does not fabricate CLI results.
OpenCode permission controls are defence in depth, not an operating-system sandbox.
Run untrusted candidate skills inside a disposable machine.

A failed command remains a failure if the agent later recovers.
A skipped or blocked case never counts as passed.
The process exits nonzero when a requested service check fails or lacks credentials.
The ordinary unit test suite does not invoke paid agent sessions or live services.

## Coverage limits

The inventory lists shell examples in the skill, CLI README, and bounded journey.
Report and Analyzer listings and Indexing API quota examples also execute from their source text.
The report marks remaining examples as uncovered.
This first suite does not claim all documentation works.
Browser OAuth, website Vue examples, MCP sessions, and real external mutations need separate journeys.
Bing pagination requires actual traffic exceeding one API page.
A smaller dataset produces a blocked result, not a pass.

The agent checks evaluate execution and selected process requirements.
They do not automatically judge every sentence in the final answer.
The consent wording check is a narrow heuristic. Review its saved transcript.
Skill discovery under implicit requests and skill-disabled comparisons remain future coverage.

## Evidence

Each run writes a report with source SHA, package version, document digests, and per-case status.
Package tarball digests identify the installed candidate. A source snapshot records uncommitted changes and new source files.
Agent runs include the OpenCode version, fixed model, events, and observed CLI calls.
Every attempt is retained. The runner does not retry failed trials automatically.
Known credential values are redacted. Files can still contain private Site data.
Keep artifacts private. Do not upload raw traces to public GitHub artifacts.

The grader tests use ordinary function inputs and assertions.
They contain no mocked services or model calls.
Run them with `pnpm test:evals`.

The approach follows [OpenAI's skill evaluation guide](https://developers.openai.com/blog/eval-skills/)
and [Anthropic's agent evaluation guide](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).

## GitHub Actions

`CLI evaluations` runs grader tests and prints the inventory for Markdown and CLI pull requests.
Its manual dispatch runs real services through the `gscdump-evals` environment.
Set environment secrets `GSC_CLIENT_ID`, `GSC_CLIENT_SECRET`, `GSC_REFRESH_TOKEN`, and `GSCDUMP_API_KEY`.
Set the environment variable `EVAL_BING_SITE` for hosted Bing pagination.
For agent trials, set `OPENCODE_GO_LOGIN` to the existing OpenCode Go CLI login JSON.
This is a CLI subscription login, not a fallback model API key.
Only dispatch trusted revisions. Configure environment approval rules before adding secrets.
The workflow publishes case statuses only. It does not upload private traces.
Scheduling remains disabled until service credentials and test Sites are configured.

## Agent waste and issues

Each agent trial records all tool events and CLI calls, including failures and denied operations.
Calls include timestamps and elapsed time.
The suite flags exact retries, repeated syncs, failed commands, empty sync responses, and unnecessary traffic queries before consent.
It records help lookups as context, without automatically treating them as waste.
Permission failures remain separate from CLI defects.

`findings.md` contains evidence and a suggested investigation for each detected issue.
`waste.json` contains the same findings as structured data.
Review transcripts for issues beyond these detectors, especially inaccurate explanations.

Rebuild findings from existing evidence without another model run:

```sh
node scripts/evals/summarize.mjs tmp/evals/RUN_DIRECTORY
```
