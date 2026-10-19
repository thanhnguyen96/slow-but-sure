# simple-workflow

Claude Code skill (`/simple-workflow`, alias `/sw`): ticket-driven software process.

- **PM**: main conversation. Grills the user, writes the epic (brief, design + mockups, system design + rough plan), coordinates.
- **lead-dev / lead-qa**: leads (default Sonnet/xhigh). Read the epic, write the detailed plan (`dev-plan.md` / `qa-plan.md`), create tickets, dispatch workers, approve or reject merged tickets. lead-dev never edits tests or runs e2e; lead-qa never edits product code (both hook-enforced). Problems on the other side go to the PM.
- **dev / qa**: workers, one ticket each, in their own git worktree. They merge their own branch into `dev` with `sw merge` and report the merge commit. Level per ticket: junior (Haiku/max), each reopen raises it to middle (Sonnet/xhigh), then senior (Opus/medium, cap).
- **reviewer**: one per round (default Opus/medium), spawned by lead-dev. Reads conventions and the whole epic once, then reviews each dev ticket as soon as it is merged. Read-only; answers APPROVE or CHANGES. Rejected tickets are fixed forward by the same worker.
- **Models**: `.claude/simple-workflow.models.json` (created on first `/sw on`). `/sw models` shows the table. Set the PM's model and effort yourself with `/model` and `/effort`.
- **Board**: `tickets/{todo,in-progress,ready-to-review,ready-to-test,done}`, prefixes `FEAT/BUG/REF/INIT/TEST`. `tickets/README.md` describes every transition.
- **Epics**: `docs/epics/<YYYYMMDD>-<slug>/` with fixed file names, so subagents need only the epic name. `merges.md` and `reviews.md` are written by `sw`.
- **Conventions**: `docs/conventions.md`, outside any epic, filled from the real codebase on the first ticketed request.
- **/sw-context**: model (effort), context size, output tokens and state of the PM and every subagent in this session.
- **Role limits** (`hooks/sw-guard.mjs`, subagents only; the PM keeps every permission): no agent pushes, resets --hard, skips hooks or touches the release branch. Each role runs only its own `sw` commands (`init`, `mv`, `mode`, `epic new` stay with the PM). dev may not write `tickets/` or `docs/`; qa/lead-qa only `qaWritable`; lead-dev no tests and no Playwright; reviewer read-only (allowlisted commands). Shell writes (`>`, `rm`, `mv`, `sed -i`, ...) are checked too. Agents use Bash only (no PowerShell). Best effort against mistakes, not a sandbox.
- **Git**: `ticket/<ID>` → `dev` (integration, via `sw merge`) → `master` (after regression and user approval).

## Install

```
node install.mjs <path-to-project> [--force] [--no-deps]
```

Copies `template/.claude/` (skills, agents, hooks), adds the hooks to `.claude/settings.json`, updates `.gitignore`, runs `sw init`. Files, hooks and the models file of the old `slow-but-sure` name are removed or migrated.

Prerequisites (skipped with `--no-deps`):
- `grill-me` + `grilling` skills from [mattpocock/skills](https://github.com/mattpocock/skills) (pinned commit) into `<project>/.claude/skills/`.
- `opendesign` plugin from [manalkaff/opendesign](https://github.com/manalkaff/opendesign), user scope, via `claude plugin install`.

Then in the project: restart Claude Code, `/sw on`. Turn off with `/sw off` (no tokens spent while off).

## sw CLI

`sw` = `node .claude/skills/simple-workflow/scripts/sw.mjs`. No arguments prints the help.

```
sw epic new edit-todo                         # docs/epics/20261019-edit-todo/
sw new feat "Edit todo title" -e 20261019-edit-todo
sw start FEAT-0001                            # todo -> in-progress
sw merge FEAT-0001                            # worker: merge into dev + checks -> ready-to-review
                                              #   exit 2 conflict, exit 3 checks failed, dev unchanged
sw approve FEAT-0001                          # -> ready-to-test, removes worktree + branch
sw reject FEAT-0001 "store.js:35 not trimmed" # -> in-progress, same worker fixes and merges again
sw reopen FEAT-0001 "AC2 failed: ..."         # -> in-progress, level +1
sw done FEAT-0001 TEST-0001                   # after regression
sw ls [status] [-e epic]   sw show FEAT-0001   sw epic   sw clean   sw models
```

Board changes are commits on `dev` in the main checkout; `sw` finds the main checkout from any worktree. One writer at a time (lock in the git dir).

## Layout

```
install.mjs
template/.claude/
  skills/simple-workflow/SKILL.md                 PM process
  skills/simple-workflow/scripts/sw.mjs           sw CLI entry: help, arg parsing, command table
  skills/simple-workflow/scripts/lib/             constants, util, repo (git, lock, commits), tickets (files, epic logs)
  skills/simple-workflow/scripts/commands/        board (init/new/start/note/mv/ls/show/clean), merge,
                                                  review (approve/reject/reopen/done), epic, setup (models/mode)
  skills/simple-workflow/scripts/context.mjs      used by /sw-context
  skills/simple-workflow/templates/conventions.md starting point for docs/conventions.md
  skills/simple-workflow/templates/tickets-README.md   copied to tickets/README.md by sw init
  skills/sw/SKILL.md                              /sw alias
  skills/sw-context/SKILL.md                      /sw-context
  agents/{lead-dev,dev,reviewer,lead-qa,qa}.md
  hooks/sw-reminder.mjs                           UserPromptSubmit, only when ON
  hooks/sw-guard.mjs                              PreToolUse (Edit|Write|NotebookEdit|Bash): role limits, subagents only
```

Requires Claude Code with nested subagents (default depth 3) and Node ≥ 18.
