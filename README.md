# slow-but-sure

Claude Code skill: ticket-driven software process.

- **PM**: main conversation (grills the user, designs, coordinates).
- **senior-dev / senior-tester**: Sonnet leads; plan, create tickets, dispatch workers, review, merge.
- **junior-dev / junior-tester**: Haiku workers; one ticket each, in their own git worktree.
- **Board**: `tickets/{todo,in-progress,ready-to-test,done}`, prefixes `FEAT/BUG/REF/INIT/TEST`.
- **Tests**: unit tests by dev; Playwright e2e in `tests/e2e/` by testers (`getByTestId`, ticket comment per test). Testers are hook-blocked from editing product code.
- **Git**: `ticket/<ID>` → `dev` (integration) → `master` (after regression + user approval).

## Install

```
node install.mjs <path-to-project> [--force] [--no-deps]
```

Copies `template/.claude/` (skill, agents, hooks), adds the reminder hook to `.claude/settings.json`, updates `.gitignore`, runs `board init`.

Prerequisites (skipped with `--no-deps`):
- `grill-me` + `grilling` skills from [mattpocock/skills](https://github.com/mattpocock/skills) (pinned commit) into `<project>/.claude/skills/`.
- `opendesign` plugin from [manalkaff/opendesign](https://github.com/manalkaff/opendesign), user scope, via `claude plugin install`. Without the `claude` CLI on PATH, the installer prints the `/plugin` commands to run manually.

Then in the project: restart Claude Code, `/slow-but-sure on`. Turn off with `/slow-but-sure off` (no tokens spent while off).

## Board CLI

```
node .claude/skills/slow-but-sure/scripts/board.mjs new FEAT "Login page" --by senior-dev --epic 20261018-auth
node .claude/skills/slow-but-sure/scripts/board.mjs move FEAT-0001 in-progress --by senior-dev --assignee junior-dev
node .claude/skills/slow-but-sure/scripts/board.mjs list
```

Board changes are committed automatically on the integration branch and refused inside linked worktrees.

## Layout

```
install.mjs
template/.claude/
  skills/slow-but-sure/SKILL.md        PM process
  skills/slow-but-sure/scripts/board.mjs
  agents/{senior,junior}-{dev,tester}.md
  hooks/sbs-reminder.mjs               UserPromptSubmit, only when ON
  hooks/sbs-tester-guard.mjs           PreToolUse for testers
```

Requires Claude Code with nested subagents (default depth 3) and Node ≥ 18.
