# slow-but-sure

Claude Code skill (`/slow-but-sure`, alias `/sbs`): ticket-driven software process.

- **PM**: main conversation. Grills the user, writes the epic (brief, design + mockups, system design + rough plan), coordinates.
- **lead-dev / lead-qa**: leads (default Sonnet/medium). Read the epic, write the detailed plan (`dev-plan.md` / `qa-plan.md`), create tickets, dispatch workers, approve or reject merged tickets. lead-dev never edits tests or runs e2e; lead-qa never edits product code (both hook-enforced). Problems on the other side go to the PM.
- **dev / qa**: workers, one ticket each, in their own git worktree. They merge their own branch into `dev` with `sbs merge` and report the merge commit. Level per ticket: junior (Haiku/medium), each reopen raises it to middle (Sonnet/medium), then senior (Opus/medium, cap).
- **reviewer**: one per batch of merged dev tickets (default Opus/medium), spawned by lead-dev. Reads conventions and the whole epic, then reviews every ticket of the batch. Read-only; answers APPROVE or CHANGES. Rejected tickets are fixed forward on the same branch by a new worker at the same level.
- **Models**: `.claude/slow-but-sure.models.json` (created on first `/sbs on`). `/sbs models` shows the table. Set the PM's model and effort yourself with `/model` and `/effort`.
- **Board**: `tickets/{todo,in-progress,ready-to-review,ready-to-test,done}`, prefixes `FEAT/BUG/REF/INIT/TEST`. `tickets/README.md` describes every transition.
- **Epics**: `docs/epics/<YYYYMMDD>-<slug>/` with fixed file names, so subagents need only the epic name. `merges.md` and `reviews.md` are written by `sbs`.
- **Conventions**: `docs/conventions.md`, outside any epic, filled from the real codebase on the first ticketed request.
- **/sbs-context**: model (effort), context size, output tokens and state of the PM and every subagent in this session.
- **Role limits** (`hooks/sbs-guard.mjs`, subagents only; the PM keeps every permission): no agent pushes, resets --hard, skips hooks or touches the release branch. Each role runs only its own `sbs` commands (`init`, `mv`, `mode`, `epic new` stay with the PM). dev may not write `tickets/`, `docs/epics/` or `docs/conventions.md`; qa/lead-qa only `qaWritable`; lead-dev no tests and no Playwright; reviewer read-only (allowlisted commands); the app and Playwright tests start only via `sbs app` / `sbs e2e` / `sbs shot` (background app with a recorded pid, always stopped), and `sbs` never runs in the background. Shell writes (`>`, `rm`, `mv`, `sed -i`, ...) are checked too. Agents use Bash only (no PowerShell). Best effort against mistakes, not a sandbox.
- **Git**: `ticket/<ID>` → `dev` (integration, via `sbs merge`) → release branch (`releaseBranch`: `master`, or `main` if only that exists; after regression and user approval).

## Install

From the project root, one command (needs Node ≥ 18 and git access to this repo):

```
npx github:thanhnguyen96/slow-but-sure            # install into the current directory
npx github:thanhnguyen96/slow-but-sure#v1.0.0     # a pinned tag or commit
npx github:thanhnguyen96/slow-but-sure --force    # upgrade: overwrite the skill files
```

From a clone: `node install.mjs [path-to-project] [--force] [--no-deps]` (path defaults to the current directory).

Copies `template/.claude/` (skills, agents, hooks), adds the hooks to `.claude/settings.json`, updates `.gitignore`, runs `sbs init`. Files, hooks, the ON flag and the models file of the interim `simple-workflow` name are removed or migrated.

Prerequisites (skipped with `--no-deps`):
- `grill-me` + `grilling` skills from [mattpocock/skills](https://github.com/mattpocock/skills) (pinned commit) into `<project>/.claude/skills/`.
- `opendesign` plugin from [manalkaff/opendesign](https://github.com/manalkaff/opendesign), user scope, via `claude plugin install`.

Then in the project: restart Claude Code, `/sbs on`. Turn off with `/sbs off` (no tokens spent while off).

## sbs CLI

`sbs` = `node .claude/skills/slow-but-sure/scripts/sbs.mjs`. No arguments prints the help.

```
sbs epic new edit-todo                         # docs/epics/20261019-edit-todo/
sbs new feat "Edit todo title" -e 20261019-edit-todo
sbs start FEAT-0001                            # todo -> in-progress
sbs merge FEAT-0001                            # worker: merge into dev + checks -> ready-to-review
                                              #   exit 2 conflict, exit 3 checks failed, dev unchanged
sbs approve FEAT-0001                          # -> ready-to-test, removes worktree + branch
sbs reject FEAT-0001 "store.js:35 not trimmed" # -> in-progress, a new worker fixes the branch, merges again
sbs reopen FEAT-0001 "AC2 failed: ..."         # -> in-progress, level +1
sbs done FEAT-0001 TEST-0001                   # after regression
sbs e2e [spec -g "name"]                       # setup app, run e2e (--reporter=line), always teardown
sbs app start|stop|status                      # app in the background (debug, Gate 3)
sbs shot -e <epic> <page>-<state> [--path /x]  # screenshot to docs/epics/<epic>/screenshots/ (starts/stops the app)
sbs shot -e <epic> --setup shot.mjs            #   states that need clicks: default async ({ page, baseURL, shot })
sbs shot -e <epic> --mockups                   # PNG of every mockups/*.html, same viewport
sbs ls [status] [-e epic]   sbs show FEAT-0001   sbs epic   sbs clean   sbs models
```

Board changes are commits on `dev` in the main checkout; `sbs` finds the main checkout from any worktree. One writer at a time (lock in the git dir).

## Layout

```
install.mjs
template/.claude/
  skills/slow-but-sure/SKILL.md                 PM process
  skills/slow-but-sure/scripts/sbs.mjs           sbs CLI entry: help, arg parsing, command table
  skills/slow-but-sure/scripts/lib/             constants, util, repo (git, lock, commits), tickets (files, epic logs)
  skills/slow-but-sure/scripts/commands/        board (init/new/start/note/mv/ls/show/clean), merge,
                                                  review (approve/reject/reopen/done), epic, setup (models/mode), app (app, e2e, shot)
  skills/slow-but-sure/scripts/context.mjs      used by /sbs-context
  skills/slow-but-sure/templates/conventions.md starting point for docs/conventions.md
  skills/slow-but-sure/templates/tickets-README.md   copied to tickets/README.md by sbs init
  skills/sbs/SKILL.md                              /sbs alias
  skills/sbs-context/SKILL.md                      /sbs-context
  agents/{lead-dev,dev,reviewer,lead-qa,qa}.md
  hooks/sbs-reminder.mjs                           UserPromptSubmit, only when ON
  hooks/sbs-guard.mjs                              PreToolUse (Edit|Write|NotebookEdit|Bash|PowerShell|Agent): role limits for
                                                   subagents; allows every call it passes (and the PM's while ON), so
                                                   auto mode's classifier does not block the process
```

Requires Claude Code with nested subagents (default depth 3) and Node ≥ 18.
