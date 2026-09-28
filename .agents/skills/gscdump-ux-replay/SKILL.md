---
name: gscdump-ux-replay
description: Replay gscdump onboarding with a fully local CLI user and a cloud user, capture loading states and screenshots, fix material defects, then combine the agent run with the user's own walkthrough. Use for launch rehearsals, first-user tests, or repeat onboarding checks.
---

# gscdump UX replay

Run the product as two new users. Record what they see before inspecting implementation.
This is a product test, not a checklist that passes because commands exit zero.

## Start each replay

1. Read the local `~/pkg/gscdump/README.md`, `AGENTS.md`, and `GLOSSARY.md`.
2. Read the local access and first-result guides linked by that README.
3. Read `~/sites/gscdump.com/AGENTS.md`, `GLOSSARY.md`, and `COPY.md` before site changes.
4. Check the installed CLI version and current command help. Use local docs when site docs differ.
5. Ask only for missing facts that change the run: browser profile, test Google identity, Site, and whether new-account admission is allowed. Recommend the least sensitive Site.
6. Make a dated note in `~/notes/gscdump-ux-replay-YYYY-MM-DD.md`. Put screenshots beside it and scratch output in `~/scratch/`.
7. Record repo revisions, CLI version, environment, browser profile, and the user-visible starting URL. Never record secrets, OAuth codes, or raw API keys.

If the user asks for simultaneous personas, delegate one run to a sub-agent. Give each run a separate browser name, CLI config, and Store. Keep one shared note and reconcile findings yourself.

## Persona A: fully local CLI

Goal: use a personal Google Cloud Desktop OAuth client or service account. Google data calls go directly from the CLI to Google. This persona does not use gscdump.com OAuth.

1. Start from the GitHub README as a visitor. Follow its local path without filling gaps from memory.
2. Make the choice between Cloud, Local with gscdump.com OAuth, and Bring Your Own Keys explicit. Choose Bring Your Own Keys for this run.
3. Use a dedicated CLI config and Store. Check current docs for the config override. Never put credentials in commands, screenshots, notes, or process arguments.
4. Set the Google credentials through the documented environment or a local ignored file. Have the user complete any Google sign-in prompt in their chosen profile.
5. Run local login, auth status, and Sites. Confirm the credential source and that requests are direct.
6. Run one live date query for the chosen Site. Confirm returned data and its source.
7. Run one bounded sync, starting with one day. Watch progress and completion. Check Store coverage, then query saved rows and confirm the source is local.
8. If the user wants an export or agent workflow, follow the README to one useful result. Do not expand to a large backfill without a reason.

Treat copied API keys as SDK or automation usage. CLI users should use `auth login`.

## Persona B: cloud service

Goal: sign in at gscdump.com, connect a Site, ingest history, and use the dashboard and cloud CLI. The CLI saves its browser-approved session. Do not ask the user to copy an API key.

1. Start at the README and enter the production site in the requested main browser profile. Use the requested Google profile.
2. Inspect the signed-out page before Google consent. Check signup availability and the waitlist path.
3. Sign in with Google, connect the chosen Site, and follow activation if offered. Record every redirect and error.
4. Watch first sync from queued through complete. Compare the visible heading, bar, counts, and action buttons with lifecycle data when available.
   If the Site already synced, record that gap. Use a new authorized Site for a fresh ingest.
   Do not disconnect a Site or repeat a large ingest just to reset the test.
5. For a large ingest, sample early, middle, near-complete, and final states. Capture any false completion, stale count, stuck spinner, or empty state shown before data loads.
6. Open Overview and Queries while syncing and after completion. Reload once to catch first-render loading errors. Check the sidebar too.
7. Run `gscdump auth login --mode cloud`, `auth status`, `sites`, and one live query from an isolated CLI config. Use the browser login flow, including `--no-browser` only when profile selection needs it.
8. Compare CLI Site progress with the dashboard. Check Domain and URL prefix rows for duplicate-host confusion.

Do not create or rotate production Google credentials unless the flow proves they are needed. Use the existing production OAuth client when it works.

## Capture evidence

For each meaningful transition, log: time, persona, action, expected result, actual result, URL or command, and evidence file.

Capture screenshots of consent entry, property choices, progress at several stages, dashboard loading and loaded states, errors, and the final result. Include desktop and narrow viewport when layout matters. Do not capture credentials or private query data beyond what the test needs.

Use `dev-browser` for browser work. Respect the user's named browser and profile. Give task pages unique names and close them at the end. Never stop shared browsers. When a personal profile cannot be automated, ask for the one needed browser action and continue independent checks.

For sync progress, record both what the UI claims and what the lifecycle API reports. A working API does not prove a clear loading state.

## Triage and repair

Before editing, replay each confusing point as a new user. Ask whether it changes a choice, hides progress, blocks a result, or costs meaningful time. Skip polish without a concrete effect.

For a material defect, record the smallest failing path, fix its cause in a task-owned `wt` worktree, add a behavior regression test when needed, and open a PR. Follow repo `AGENTS.md`, review, CI, merge authority, deploy workflow, and production smoke rules. Preserve screenshots before and after.

Keep operations failures separate from product UX. Do not turn one test into an unrelated backlog sweep.

## Bring in the user's run

If the user runs alongside the agent, add their observations as they arrive.
After the agent's fixes are live, give the user the note link and this short prompt:

> Start at the README in your normal browser. Tell me where you paused, guessed, waited, or saw a result you did not trust. Send rough notes or screenshots. I will add your path beside mine and check each difference.

Add a `Your walkthrough` section to the same note. Preserve the user's words beside the agent observation. For each difference, record whether it reproduces, what caused it, and the resulting fix or reason to skip. Ask for one missing screenshot or step only when it changes the diagnosis.

The replay closes when both personas have a verified useful result and the user's supplied walkthrough has been reconciled. If the user has not run it yet, hand over the exact starting point and keep the note ready for that pass. Never claim the user's pass happened.

## Report

The note contains a short result, a Mermaid path diagram, a timed workflow table, screenshots with relative links, and a findings table with evidence and disposition.

Give the user a three-line summary and `https://notes.localhost/notes/<note-name>`.
State end-to-end confidence from observed behavior. Name any path that remains untested.
