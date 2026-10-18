# Ticket board

Every ticket is a markdown file. The folder it sits in is its status. Change tickets only through the board script, never by moving or editing frontmatter by hand:

```
node .claude/skills/slow-but-sure/scripts/board.mjs <new|move|note|list|models>
```

Every board change is committed on the integration branch (`dev`) from the main checkout. The script refuses to run inside a worker worktree.

## Statuses

| Folder | Meaning |
|---|---|
| `todo/` | Created, not started. |
| `in-progress/` | A worker is on it (`assignee` says who, `level` says at which level). |
| `ready-to-test/` | Merged into `dev` and checked by its lead; waiting for e2e regression. |
| `done/` | Passed regression. Closed. |

## Ticket types

| Prefix | Use | Created by |
|---|---|---|
| `FEAT` | New feature | dev-lead |
| `BUG` | Bug fix | pm (from regression evidence or a user report), dev-lead |
| `REF` | Refactor | dev-lead |
| `INIT` | Project setup | dev-lead |
| `TEST` | Playwright e2e tests; `covers` lists the dev tickets it tests | tester-lead |

IDs are `<PREFIX>-<4 digits>` (for example `FEAT-0001`), one counter per prefix.

## Flow of a dev ticket (FEAT, BUG, REF, INIT)

```
todo ──> in-progress ──> ready-to-test ──> done
              ^                │
              └──── reopen ────┘   (regression found a dev-caused failure)
```

| Transition | Who | When |
|---|---|---|
| created in `todo` | dev-lead (BUG also pm) | Planned in `docs/specs/<epic>/plan.md`. |
| `todo` → `in-progress` | dev-lead, `--assignee dev` | A dev worker is spawned for it in its own worktree on branch `ticket/<ID>`. |
| `in-progress` → `ready-to-test` | dev-lead | Diff reviewed, merged into `dev`, unit/build/lint green on `dev`, worktree and branch removed. |
| `ready-to-test` → `done` | tester-lead | The full e2e suite passed in regression. |
| back to `in-progress` (reopen) | dev-lead | A BUG fix failed regression again, a worker failed twice, or the PM sent it back. |

A dev-caused regression failure on a FEAT does not reopen the FEAT: the PM opens a `BUG` that depends on it. The FEAT goes to `done` together with the rest once regression is green.

## Flow of a TEST ticket

```
todo ──> in-progress ──> ready-to-test ──> done
              ^                │             │
              └──── reopen ────┴─────────────┘   (the test itself was wrong)
```

| Transition | Who | When |
|---|---|---|
| created in `todo` | tester-lead, `--covers FEAT-0001,...` | Scenarios written per acceptance criterion. |
| `todo` → `in-progress` | tester-lead, `--assignee tester` | A tester worker writes the spec files in its own worktree. |
| `in-progress` → `ready-to-test` | tester-lead | Tests reviewed, compile, merged into `dev`. |
| `ready-to-test` → `done` | tester-lead | The suite passed in regression. |
| back to `in-progress` (reopen) | tester-lead | A failure is test-caused (wrong locator or expectation, flaky wait). The owning TEST ticket is reopened, even from `done`; no new TEST ticket is created. |

Testers never touch product code; a hook blocks it.

## Reopen and levels

- A move back to `in-progress` after the ticket has left it is a **reopen**.
- A reopen needs `--note "<context summary>"`: what was expected, what failed (test, error, file:line), and what was already tried. The new worker gets this summary in its prompt.
- Every ticket starts at level `junior`. Each reopen raises it one step: `junior` → `middle` → `senior` (cap). The level picks the worker's model and effort from `.claude/slow-but-sure.models.json`.

## Ticket file

Frontmatter: `id`, `type`, `title`, `epic`, `created`, `updated`, `status`, `assigner`, `assignee`, `level`, `branch`, `depends_on`, `covers`.

Body: Context, Scope, Acceptance criteria, data-testid table, and a History section where the script appends one line per create, move and note.

## Other files

- `config.json`: integration and release branches, project commands (unit, build, lint, e2e, app), and the paths testers may write.
- `.counters.json`: last number used per prefix. Don't edit.
