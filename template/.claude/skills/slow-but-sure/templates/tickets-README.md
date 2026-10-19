# Ticket board

Every ticket is a markdown file. The folder it sits in is its status. Change tickets only through `sbs`, never by moving files or editing frontmatter by hand:

```
node .claude/skills/slow-but-sure/scripts/sbs.mjs        # prints the help
```

Every board change is a commit on `dev` in the main checkout. `sbs` also works from a worker's worktree: it always writes to the main checkout.

## Statuses

| Folder | Meaning |
|---|---|
| `todo/` | Created, not started. |
| `in-progress/` | A worker is on it (`assignee`, `level`). |
| `ready-to-review/` | The worker merged it into `dev` with `sbs merge`; unit/build/lint passed on the merged result. `merge` in the frontmatter is the merge commit. Waiting for review. |
| `ready-to-test/` | Review approved. Waiting for e2e regression. |
| `done/` | Passed regression. Closed. |

## Ticket types

| Prefix | Use | Created by |
|---|---|---|
| `FEAT` | New feature | lead-dev |
| `BUG` | Bug fix | pm (from regression evidence or a user report), lead-dev |
| `REF` | Refactor | lead-dev |
| `INIT` | Project setup | lead-dev |
| `TEST` | Playwright e2e tests; `covers` lists the dev tickets it tests | lead-qa |

IDs are `<PREFIX>-<4 digits>`, one counter per prefix.

## Flow of a dev ticket (FEAT, BUG, REF, INIT)

```
todo ──> in-progress ──> ready-to-review ──> ready-to-test ──> done
             ^  ^               │                  │
             │  └── reject ─────┘                  │
             └──────── reopen (level +1) ──────────┘
```

| Command | Who | From → to | What happens |
|---|---|---|---|
| `sbs new feat "<title>" -e <epic>` | lead-dev (BUG also pm) | → `todo` | Planned in `docs/epics/<epic>/dev-plan.md`. |
| `sbs start <ID>` | lead-dev | `todo` → `in-progress` | A dev worker is spawned in its own worktree on `ticket/<ID>`. |
| `sbs merge <ID>` | dev | `in-progress` → `ready-to-review` | Merges `ticket/<ID>` into `dev` (`--no-ff`), runs `mergeChecks` on the result, commits, logs to `merges.md`. Conflict: exit 2, red checks: exit 3; in both cases nothing is merged and `dev` is unchanged. |
| `sbs approve <ID>` | lead-dev, on the reviewer's APPROVE | `ready-to-review` → `ready-to-test` | Logs to `reviews.md`, removes the worktree and the merged branch. |
| `sbs reject <ID> "<findings>"` | lead-dev, on the reviewer's CHANGES | `ready-to-review` → `in-progress` | Same worker, same level. It fixes on its branch and runs `sbs merge` again (fix forward: the first merge stays in `dev`). |
| `sbs done <ID...>` | lead-qa | `ready-to-test` → `done` | The full e2e suite passed. |
| `sbs reopen <ID> "<summary>"` | lead-dev | any started → `in-progress` | Rejected twice, worker failed twice, or the PM sent it back. Level goes up. |

A dev-caused regression failure on a FEAT does not reopen the FEAT: the PM opens a `BUG` that depends on it. The FEAT goes to `done` with the rest once regression is green.

## Flow of a TEST ticket

```
todo ──> in-progress ──> ready-to-review ──> ready-to-test ──> done
             ^  ^               │                  │             │
             │  └── reject ─────┘                  │             │
             └──────── reopen (level +1) ──────────┴─────────────┘
```

Same commands, run by lead-qa and qa. lead-qa reviews TEST tickets itself (no reviewer agent). A test-caused regression failure reopens the TEST ticket that owns the test, even from `done`; no new TEST ticket is created.

## Reopen and levels

- `sbs reopen` needs a context summary: what was expected, what failed (test, error, file:line), what was already tried. The new worker gets it in its prompt.
- Tickets start at `junior`. Each reopen raises the level one step: `junior` → `middle` → `senior` (cap). The level picks the worker's model and effort from `.claude/slow-but-sure.models.json`.
- `sbs reject` does not change the level.

## Ticket file

Frontmatter: `id`, `type`, `title`, `epic`, `created`, `updated`, `status`, `assigner`, `assignee`, `level`, `branch`, `merge` (last merge commit), `depends_on`, `covers`.

Body: Context, Scope (In / Out), Contracts, Acceptance criteria, data-testid table, and a History section where `sbs` appends one line per change.

## Other files

- `config.json`: branches, project commands (unit, build, lint, e2e, app), `mergeChecks` (commands `sbs merge` runs), `qaWritable` (where lead-qa and qa may write), `leadDevBlocked` (test paths lead-dev may not write).
- `.counters.json`: last number used per prefix. Don't edit.
- `docs/epics/<epic>/merges.md` and `reviews.md`: written by `sbs`; the trail of every merge and review.
