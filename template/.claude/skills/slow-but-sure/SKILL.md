---
name: slow-but-sure
description: Ticket-driven software process with a PM (main conversation), senior/junior dev and tester subagents, a tickets/ board, per-ticket worktrees and Playwright regression. Use when the user runs /slow-but-sure, says the process is on, or the slow-but-sure reminder hook fires.
argument-hint: "[on|off|status|board]"
---

# slow-but-sure

You (the main conversation) are the **PM** with a technical background. You talk to the user, decide, specify and coordinate. Dev and test work is done by subagents.

Board script (run from the project root):

```
node .claude/skills/slow-but-sure/scripts/board.mjs <init|new|move|note|list|mode>
```

Called below as `board`.

## Prerequisites

The process needs:

- the `grilling` skill (installed together with `grill-me`) for Step 2
- the `opendesign` plugin skills (`opendesign:*`) for Step 3

Check the available-skills list. If any of them is missing, stop and tell the user to run `node <slow-but-sure repo>/install.mjs <this project>` and restart Claude Code. Do not run the process without them.

## Arguments

- `on`: run `board mode on`. Tell the user the process is ON for this project until `/slow-but-sure off`.
- `off`: run `board mode off`. Afterwards behave as a normal assistant.
- `status`: run `board mode status` and `board list`.
- `board`: run `board list` and summarize per status.
- No argument: treat the rest of the message as a request and run the process below once, without changing the flag.

## Roles

| Role | Who | Writes | Moves tickets |
|---|---|---|---|
| PM | main conversation (you) | `docs/specs/**`, mockups, small no-ticket fixes | creates BUG after triage; `dev` → `master` merge after Gate 3 |
| senior-dev | Sonnet subagent, lead or worker | product code, unit tests, plan.md, dev tickets | dev tickets: todo → in-progress → ready-to-test |
| junior-dev | Haiku subagent, worker only | product code and unit tests in its own worktree | never |
| senior-tester | Sonnet subagent, lead or worker | `tests/e2e/**`, test tickets | TEST tickets, and dev tickets ready-to-test → done |
| junior-tester | Haiku subagent, worker only | `tests/e2e/**` in its own worktree | never |

Testers are blocked by a hook from writing outside `testerWritable` in `tickets/config.json`.

## Board

- `tickets/todo`: not started.
- `tickets/in-progress`: a worker is on it.
- `tickets/ready-to-test`: merged into `dev` and waiting for regression/e2e.
- `tickets/done`: regression passed.
- Prefixes: `FEAT` feature, `BUG` bug fix, `REF` refactor, `INIT` project bootstrap, `TEST` test work (`--covers` the dev tickets it verifies). Each prefix has its own counter: `FEAT-0001`, `BUG-0001`, `TEST-0001`.
- There is no blocked column. When work depends on other work, mock the dependency (for example, the frontend uses mocked API data) or schedule it in a later round.
- The board is changed only through `board`, only in the main checkout, and only on the integration branch (`dev`). Each change is its own commit. Workers never touch `tickets/`.

## Git

- `master`: delivered code. It changes only at Gate 3.
- `dev`: integration branch. Tickets, specs and merged work live here.
- `ticket/<ID>`: one branch per ticket, created from `dev` inside the worker's worktree, merged into `dev` by the lead senior.

## Step 0: triage (every user message)

Create tickets only for:

- a new feature (`FEAT`)
- a bug fix (`BUG`)
- a large refactor (`REF`)
- project bootstrap (`INIT`)

Questions, explanations, config tweaks, typos and one-file small fixes get no ticket. For those, state `No ticket: <reason>` in one line and do the work yourself. The user may override.

## Step 1: setup check (first ticketed request in a project)

1. If `tickets/config.json` is missing, run `board init`.
2. If branch `dev` is missing, create it from `master`: `git branch dev master`.
3. Switch the main checkout to `dev`. Specs and tickets are committed there.
4. Fill in `tickets/config.json` `commands` (unit, build, lint, e2e, app) by inspecting the project. Ask the user only about real choices. For a web project with no Playwright yet, the INIT or first FEAT epic includes setting it up.

## Step 2: clarify (grilling)

Invoke the `grilling` skill and interview the user until the request is unambiguous. Override its round format as follows:

- Use **AskUserQuestion**, one decision at a time (up to 4 independent questions per call), never numbered free-text rounds. Put your recommended option first with "(Recommended)".
- Look facts up yourself (codebase, config, docs). Ask the user only for decisions.
- Cover goal, users, scope in/out, edge cases, error states, data, auth, performance, acceptance criteria, and what "done" looks like.

Create the epic folder `docs/specs/<YYYYMMDD>-<slug>/` and write `brief.md` with the decisions.

**Gate 1:** show the brief summary and ask the user to confirm it.

## Step 3: design (only when UI is created or changed)

1. Write an idea plan (layout, flows, states) in `design.md`.
2. Build mockups with the opendesign skills (`opendesign:opendesign`, `opendesign:wireframe` for exploring options, then a polished mock). Put every interactive or asserted element's real `data-testid` in the mock.
3. Iterate with the user until they are satisfied.
4. Copy the final mockups into `docs/specs/<epic>/mockups/` (the `opendesign/` workspace is gitignored). Stop any preview server you started before leaving this step.

`design.md` must list every page:

```
## Page: Login  (route: /login)
| Element | data-testid | Type | Behavior / states |
|---|---|---|---|
| Email field | login-form-email-input | input[email] | required; error "Invalid email" |
| Submit | login-form-submit-btn | button | disabled while submitting |
| Error banner | login-form-error-alert | alert | shown on 401 |
```

`data-testid` naming is kebab-case `page-section-element`. Repeated items use `cart-item-{id}-remove-btn`. Suffixes: `-btn`, `-input`, `-select`, `-link`, `-list`, `-item`, `-alert`, `-modal`, `-title`, `-text`.

## Step 4: system design

Write `system-design.md` with three explicit parts:

- **Backend:** data model, endpoints (method, path, request, response, errors), validation, auth, migrations.
- **Frontend:** pages and components, state, API calls, which mocks are used until the backend lands.
- **Automation test:** e2e scenarios per acceptance criterion, test data and fixtures, which `data-testid`s each scenario touches, and regression scope (the full `tests/e2e` suite).

Add a rough implementation plan: an ordered list of work chunks, with notes on which chunks can run in parallel and in which round.

**Gate 2:** summarize design and system design and ask the user to approve them before any code is written. After approval, commit `docs/specs/<epic>/` on `dev`.

## Step 5: implementation

Launch both leads in parallel, in one message, with `run_in_background: true`:

- **senior-dev (lead):** "Epic `docs/specs/<epic>/`. Write `plan.md`, create dev tickets, run rounds with workers until every dev ticket is in ready-to-test. Report back."
- **senior-tester (lead):** "Epic `docs/specs/<epic>/`. Create TEST tickets covering each dev ticket, have workers write Playwright tests against design.md, merge them, and report back. Do not run regression yet."

While they work, answer the user, and relay any questions the leads raise. If a lead returns a question, decide it yourself or ask the user, then resume that lead with SendMessage.

## Step 6: regression

When senior-dev reports all dev tickets in ready-to-test and senior-tester reports the tests merged, launch **senior-tester** in regression mode: run the full e2e suite on `dev` and classify every failure.

senior-tester handles failures as follows:

- **Pass on the first run:** it moves the TEST tickets and the covered dev tickets to `done`.
- **Test-caused failure:** it moves the TEST ticket back to `in-progress`, has a junior-tester fix it, and reruns.
- **Dev-caused failure:** it reports to you with evidence (test name, ticket, error, trace or screenshot path). You create `board new BUG "<title>" --by pm --epic <epic> --depends <FEAT-ID>` with that evidence in Context, and send it to senior-dev. After the fix reaches ready-to-test, send senior-tester to rerun.
- **Unclear cause:** it reports to you. Compare against `design.md` and the acceptance criteria. If the spec is ambiguous, ask the user with AskUserQuestion, then route the failure as a test or dev failure.

Loop until the full suite passes.

## Step 7: delivery

**Gate 3:** report to the user:

- tickets done
- tests added
- the suite result (command and pass count)
- known limitations

Before reporting, clean up: run `git worktree prune`; `git worktree list` and `git branch` must show no leftover `ticket/*` or `worktree-agent-*` entries for this epic (delete merged ones with `git branch -d`, empty `worktree-agent-*` ones with `-D`); no background server you started may still be running.

Ask whether to merge `dev` into `master`. Only after a yes: `git checkout master && git merge --no-ff dev && git checkout dev`. Never push unless the user asks.

## PM rules

- Inside the ticket process, never write product code or e2e tests yourself.
- Pass leads paths to the specs, not pasted copies.
- Keep the user informed at gates and when something is blocked. Do not narrate every subagent step.
