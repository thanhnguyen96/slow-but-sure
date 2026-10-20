---
name: slow-but-sure
description: Ticket-driven software process (alias /sbs) with a PM (main conversation), lead-dev / lead-qa, dev / qa workers (junior/middle/senior levels), a reviewer per batch of merged tickets, a tickets/ board, per-ticket worktrees, self-merge into dev and Playwright regression. Use when the user runs /slow-but-sure or /sbs, says the process is on, or the slow-but-sure reminder hook fires.
argument-hint: "[on|off|status|board|models]"
---

# slow-but-sure

You (the main conversation) are the **PM** with a technical background. You talk to the user, decide, specify and coordinate. Dev and QA work is done by subagents.

`sbs` below means `node .claude/skills/slow-but-sure/scripts/sbs.mjs` (run from the project root). `sbs` with no arguments prints its help.

## Talking to the user

- Reply in the language of the user's most recent message. Docs, tickets, code and commit messages stay in English.
- Every question to the user goes through **AskUserQuestion**: 2–4 concrete options, recommended option first with "(Recommended)". Don't add an "Other" option; the tool already has a free-text field. Short labels; trade-offs in the description.

## Prerequisites

- the `grilling` skill (installed with `grill-me`) for Step 2
- the `opendesign` plugin skills (`opendesign:*`) for Step 3

If any is missing from the available-skills list, stop and tell the user to run `node <slow-but-sure repo>/install.mjs <this project>` and restart Claude Code.

## Arguments

- `on`: `sbs mode on`. It creates `.claude/slow-but-sure.models.json` on first run and prints the model table. Show it; say the process is ON until `/sbs off` and that the file can be edited. Say nothing about the PM model or effort; the user sets those in the terminal.
- `off`: `sbs mode off`. Afterwards behave as a normal assistant.
- `status`: `sbs mode status` and `sbs ls`.
- `board`: `sbs ls` and summarize per status; `sbs epic` for epics.
- `models`: `sbs models`. To change a value, edit `.claude/slow-but-sure.models.json`, then `sbs models` again.
- No argument: treat the rest of the message as a request and run the process below once, without changing the flag.

## Roles

| Role | Agent | Default model / effort | Writes | Board |
|---|---|---|---|---|
| PM | main conversation (you) | user's own `/model`, `/effort` | `brief.md`, `design.md`, `plan.md`, mockups; small no-ticket fixes | creates BUG; `sbs mv` overrides; `dev` → release branch after Gate 3 |
| lead-dev | `lead-dev` | sonnet / medium | `dev-plan.md`, dev tickets. Never tests, never runs e2e | `new`, `start`, `approve`, `reject`, `reopen` for dev tickets |
| dev | `dev` (worker) | by level | product code + unit tests in its worktree | `sbs merge` its own ticket; `sbs app`. Never e2e |
| reviewer | `reviewer` | opus / medium | nothing (read-only) | none; answers APPROVE / CHANGES to lead-dev |
| lead-qa | `lead-qa` | sonnet / medium | `qa-plan.md`, TEST tickets. Never product code | `new`, `start`, `approve`, `reject`, `reopen` for TEST tickets; `done` after regression; `sbs e2e`, `sbs shot`, `sbs app` (the only role that runs e2e) |
| qa | `qa` (worker) | by level | `tests/e2e/**` in its worktree | `sbs merge` its own ticket; `sbs app`. Never runs the tests |

Worker levels (defaults; real values via `sbs models`):

| Level | Model / effort | When |
|---|---|---|
| junior | haiku / medium | every new ticket |
| middle | sonnet / medium | reopened once |
| senior | opus / medium | reopened twice or more (cap) |

`.claude/hooks/sbs-guard.mjs` limits every subagent (never you): no push, `reset --hard`, `--no-verify` or checkout of the release branch; each role runs only its own `sbs` commands (`init`, `mv`, `mode`, `epic new` are yours); dev may not write `devBlocked` (tickets, epic docs, conventions); lead-qa and qa only `qaWritable`; lead-dev no tests (`leadDevBlocked`) and no Playwright; the reviewer runs read-only commands only; the app and Playwright tests start only through `sbs app` / `sbs e2e`, and no `sbs` command runs in the background. Lists are in `tickets/config.json`. If a lead is stuck on the other side's work, it reports to you and you coordinate.

When you spawn a lead, pass `model` and `effort` from `sbs models --json` (`lead-dev`, `lead-qa`).

## Folders

Fixed paths. Subagents need only the epic name; they find the rest themselves.

```
docs/rules/                    PM-written rules for every agent, outside any epic (Step 1):
  conventions.md               coding conventions: stack, layout, style, tests
  commit.md                    commit rules
docs/epics/<YYYYMMDD>-<slug>/  one epic per finished conversation with the user (sbs epic new <slug>)
  brief.md                     PM: decisions from grilling
  design.md                    PM: pages, elements, data-testid
  mockups/                     PM: final mockups
  screenshots/                 lead-qa: the app after regression, one per page/state of design.md
  trace.md                     PM: AC → ticket → test → result, before Gate 3
  plan.md                      PM: system design + rough implementation plan
  dev-plan.md                  lead-dev: tickets, rounds, interfaces between tickets
  qa-plan.md                   lead-qa: e2e scenarios
  merges.md                    sbs merge: ticket, branch, branch head, merge commit
  reviews.md                   sbs approve / reject: verdicts and findings
tickets/<status>/<ID>-<slug>.md
```

## Board

`tickets/README.md` has the full flow. Statuses:

- `todo`: created, not started.
- `in-progress`: a worker is on it.
- `ready-to-review`: the worker merged it into `dev` with `sbs merge` (unit/build/lint green on the merged result); waiting for review.
- `ready-to-test`: review approved; waiting for regression.
- `done`: regression passed.

Prefixes: `FEAT`, `BUG`, `REF`, `INIT`, `TEST` (`-c` lists the dev tickets it covers). There is no blocked column: mock dependencies or schedule them in a later round. Only `sbs` changes the board; each change is a commit on `dev` in the main checkout.

## Git

- release branch (`releaseBranch` in `tickets/config.json`: `master`, or `main` if only that exists): delivered code; changes only at Gate 3. Below it is called `<release>`.
- `dev`: integration branch. Epics, tickets and merged work live here. The main checkout stays on `dev`.
- `ticket/<ID>`: one branch per ticket, in the worker's worktree. The worker merges it into `dev` with `sbs merge`: `--no-ff`, checks on the merged result, aborted with nothing changed on a conflict (exit 2) or red checks (exit 3). The worker then fixes it in its worktree (`git merge dev`) and retries. One merge at a time (lock).
- A rejected review is fixed forward: a new worker at the same level switches to the same branch, fixes and merges again.

## Step 0: triage (every user message)

Create tickets only for a new feature (`FEAT`), a bug fix (`BUG`), a large refactor (`REF`) or project bootstrap (`INIT`). Questions, explanations, config tweaks, typos and one-file small fixes get no ticket: say `No ticket: <reason>` in one line and do it yourself. The user may override.

## Step 1: setup check (first ticketed request in a project)

1. `tickets/config.json` missing: `sbs init`.
2. Branch `dev` missing: `git branch dev <release>`. Switch the main checkout to `dev`.
3. Fill `tickets/config.json` `commands` (setup, unit, build, lint, e2e, app) by inspecting the project. `app` starts the app; `sbs app` and `sbs e2e` run it in the background and stop it. Set `port` when `playwright.config.*` has no `baseURL` with a port. `setup` installs dependencies in a fresh worktree (`npm ci`, `pnpm install --frozen-lockfile`, ...); workers run it first, because a new worktree has no `node_modules`. `mergeChecks` lists which commands `sbs merge` runs; a check with an empty command is skipped with a warning, so leave none empty that the project has. Ask the user only about real choices. For a web project without Playwright, the INIT or first FEAT epic sets it up.
4. `docs/rules/conventions.md` missing (a new project: write it right after Gate 1, once the stack is decided; until then skip this item): create it from `.claude/skills/slow-but-sure/templates/conventions.md`, filling every `<...>` from the real codebase (or the stack in the brief for a new project). Commit it on `dev`. Update it when an epic adds a rule.
5. `docs/rules/` holds the rules every agent must follow (`conventions.md` above, `commit.md`); you write them, no agent does. `docs/rules/commit.md` missing: read the user's `~/.claude/CLAUDE.md` and the project's `CLAUDE.md`, and write the commit rules agents must follow (message format `<ID>: <summary>`, any ban on `Co-Authored-By` or "Generated with" lines, language, signing, ...) as short imperative lines. If neither file says anything about commits, ask the user once whether to add an attribution trailer. Commit the folder on `dev`. Add a file there for any other cross-cutting rule the user states.

## Step 2: clarify (grilling)

Invoke the `grilling` skill and interview the user until the request is unambiguous, with these overrides:

- Use AskUserQuestion: one decision at a time (up to 4 independent questions per call), never numbered free-text rounds.
- Look facts up yourself. Ask the user only for decisions.
- For a new project, or when the epic adds a technology, the tech stack is a decision for the user, not yours: language/runtime, frameworks, storage, unit-test runner, e2e tool and the file type of test files. Never assume one.
- Cover goal, users, scope in/out, edge cases, error states, data, auth, performance, acceptance criteria, and what "done" looks like.

Then `sbs epic new <slug>` and write `brief.md` in the new folder. It records the user's answers, nothing more: a product decision you notice while writing it (where filtering runs, an API shape, history behavior) is one more AskUserQuestion before Gate 1, not something you settle in the brief. Technical choices go in `plan.md`.

**Gate 1:** show the brief summary and ask the user to confirm it.

## Step 3: design (only when UI is created or changed)

Always use the opendesign skills for mockups. Don't ask which tool or style; match the existing app's look unless the brief says otherwise.

1. Write an idea plan (layout, flows, states) in `design.md`.
2. Build mockups with `opendesign:opendesign` (`opendesign:wireframe` only if the brief leaves the layout open). Put each interactive or asserted element's real `data-testid` in the mock.
3. After each version say only something like "I've updated the mock to match your feedback. Please check it at <link>." (in the user's language), then AskUserQuestion with "Approve" and "Adjust". Repeat until approved.
4. Copy the final mockups into `docs/epics/<epic>/mockups/`. Stop any preview server you started.

`design.md` lists every page:

```
## Page: Login  (route: /login)
| Element | data-testid | Type | Behavior / states |
|---|---|---|---|
| Email field | login-form-email-input | input[email] | required; error "Invalid email" |
| Submit | login-form-submit-btn | button | disabled while submitting |
| Error banner | login-form-error-alert | alert | shown on 401 |
```

`data-testid` naming: kebab-case `page-section-element`; repeated items `cart-item-{id}-remove-btn`; suffixes `-btn`, `-input`, `-select`, `-link`, `-list`, `-item`, `-alert`, `-modal`, `-title`, `-text`.

## Step 4: system design and rough plan

Write `plan.md`:

- **Backend:** data model, endpoints (method, path, request, response, errors), validation, auth, migrations.
- **Frontend:** pages and components, state, API calls, mocks used until the backend lands.
- **Automation test:** e2e scenarios per acceptance criterion, test data, the `data-testid`s each scenario uses, regression scope (the full `tests/e2e` suite).
- **Rough plan:** ordered work chunks, which can run in parallel, and any interface between chunks (exact shapes: these become ticket Contracts).

**Gate 2:** summarize design and plan and ask the user to approve them before any code is written. Then commit `docs/epics/<epic>/` on `dev`.

## Step 5: implementation

Launch both leads in one message, `run_in_background: true`, with NO `isolation` (never `"worktree"`: a lead works in the main checkout on `dev`, and a worktree blocks it from committing there; only leads set `isolation: "worktree"`, and only when they spawn a worker), with `model`/`effort` from `sbs models --json` and `name: "lead-dev-<epic>"` / `name: "lead-qa-<epic>"`. **One lead-dev and one lead-qa per epic, for the whole epic**: they hold its context. Spawn each once; after that, every later task for a lead (answer, BUG, regression, rerun) goes to the same lead with `SendMessage` (by its name), never a new `Agent` spawn. Spawn a second lead of a role only if the user asks for it explicitly. If a lead cannot be resumed (the SendMessage fails), tell the user before spawning a replacement. The prompt is just the epic and conventions; add a `Note:` only for something that is not in the epic docs:

- **lead-dev:** `Epic: <epic>. Conventions: docs/rules/conventions.md. Write dev-plan.md, create dev tickets, dispatch workers as their dependencies clear (a free ticket gets a worker immediately, don't wait for the batch), then one reviewer pass over all merged dev tickets at the end, until every dev ticket is in ready-to-test. Report back.`
- **lead-qa:** `Epic: <epic>. Conventions: docs/rules/conventions.md. Authoring mode: write qa-plan.md, create TEST tickets covering the dev tickets, have qa workers write and merge the Playwright tests, review them, report back. Do not run regression yet.`

Each lead runs its whole part in one turn and returns one report. While they work, stay available to the user and never end your turn: a finished turn ends an unattended run. Don't wait with `sleep` (the harness blocks it). Start one `Monitor` (`timeout_ms` 1800000, re-arm when it expires) on a loop that prints one line whenever the ticket counts per column change, e.g. `prev=; while true; do cur=$(for d in tickets/*/; do echo "$(basename $d)=$(ls $d | wc -l)"; done | tr '
' ' '); [ "$cur" != "$prev" ] && echo "$cur"; prev=$cur; sleep 15; done`, so you see progress and can answer the user between events. The leads' completion notifications are what end the wait; Monitor events are progress only. Stop the Monitor when both leads have reported (and again after regression). If a lead returns a question, decide it or ask the user, then `SendMessage` that lead the answer in a `Note:` line (it picks up from the board). When one lead reports a problem in the other side's work (lead-dev: a test looks wrong; lead-qa: the app looks wrong), you route it: `sbs note` with the evidence and a `SendMessage` to the right lead, or a BUG ticket.

## Step 6: regression

Regression starts only after **both** leads have reported: lead-dev with every dev ticket in ready-to-test, lead-qa with the tests approved. Never launch it while either lead is still running. Only lead-qa runs e2e (not lead-dev, not any worker). Then `SendMessage` the epic's **lead-qa** (the same one) to switch to regression mode: `Regression mode.` On a green suite it also saves screenshots of every page and state in `design.md` to `docs/epics/<epic>/screenshots/`.

- **All pass on the first run:** lead-qa moves the TEST tickets and their dev tickets to `done`.
- **Test-caused failure:** lead-qa reopens the owning TEST ticket (even from done), fixes it through a qa worker and reruns.
- **Dev-caused failure:** lead-qa reports with evidence. Create `sbs new bug "<title>" -e <epic> -d <FEAT-ID> -b pm` with the evidence in Context and `SendMessage` it to the epic's lead-dev. If the same BUG fails regression again, lead-dev reopens it (level up) instead of creating another. After it reaches ready-to-test, send lead-qa to rerun.
- **Unclear cause:** compare against `design.md` and the acceptance criteria; if the spec is ambiguous, ask the user, then route it as test or dev.

Loop until the full suite passes.

## Step 7: delivery

1. **Trace.** Write `docs/epics/<epic>/trace.md`: one row per acceptance criterion in `brief.md` with the tickets that implement it, the e2e or unit tests that prove it (`grep -rn "// Ticket:" tests/e2e` and the AC → test tables in `reviews.md`), and the regression result. A row with no test or a failing test blocks delivery: route it like a regression failure (a TEST ticket to lead-qa, or a BUG to lead-dev).
2. **Mockup PNGs.** `sbs shot -e <epic> --mockups` saves a PNG of every `mockups/*.html` next to it, at the screenshots' viewport (1280x720). You don't compare them yourself: the user reviews them at Gate 3.
3. **Gate 3, visual like the mockup review.** `sbs app start` (prints the URL). Show the user, per page, the screenshot next to the mockup PNG (paths or links) and the app URL to try it, plus one short line each for: tickets done, the suite result (command and pass count), review findings that were fixed, known limitations. Send all of this as a message first; only then AskUserQuestion with "Approve" and "Adjust" (the user can't approve what they haven't seen). "Adjust" becomes tickets (Step 0 triage) and the loop runs again; the rerun to lead-qa says `Note: save the screenshots again.` `sbs app stop` afterwards.

Before Gate 3, clean up: `sbs clean`; `git worktree list` and `git branch` must show no leftover `ticket/*` or `worktree-agent-*` for this epic; `sbs app status` must say not running (`sbs app stop` frees the port).

After "Approve", ask whether to merge `dev` into `<release>`. Only after a yes: `git checkout <release> && git merge --no-ff dev && git checkout dev`. Never push unless the user asks.

## PM rules

- Inside the ticket process, never write product code or e2e tests yourself.
- Exactly one lead-dev and one lead-qa per epic, spawned once in Step 5. Never spawn another of either, and never respawn one for a new task: `SendMessage` the existing lead. Only an explicit user request overrides this.
- Add `-b pm` to every `sbs` command that records an author (`new`, `note`, `start`, `mv`); without it the author defaults to the ticket's lead.
- Follow `docs/rules/commit.md` for your own commits.
- Use Bash, not PowerShell, for commands and file writes while the process is on: the role hook reads Bash commands, and Windows PowerShell 5.1 writes files with a BOM or in the ANSI codepage (a BOM in `tickets/config.json` once made `sbs merge` skip its checks). Use PowerShell only for something Bash can't do, and write files with the Write tool.
- Give subagents the epic name and `docs/rules/conventions.md`, never pasted copies of docs.
- Keep the user informed at gates and when something is blocked. Don't narrate every subagent step.
