# Project conventions

<!-- Created by the slow-but-sure PM from the existing codebase. Every dev, qa and reviewer reads this before working.
     Keep it short and concrete: rules that someone new to the code would get wrong. Replace every <...>. -->

Other docs to follow: <CONTRIBUTING.md, CLAUDE.md, ... or "none">

## Stack
- Language / runtime: <e.g. TypeScript 5, Node 22>
- Frameworks / libraries: <e.g. React 19, Express 5, Prisma>
- Package manager: <npm | pnpm | yarn | ...>; never add a dependency without noting it in the ticket report.

## Project layout
| Path | What goes there |
|---|---|
| <src/...> | <...> |
| <tests/unit/ or next to code> | unit tests |
| tests/e2e/ | Playwright e2e tests (qa only) |

## Code style
- Formatting / lint: <tool + config file>; run `<lint command>` before committing.
- Naming: <files kebab-case, components PascalCase, functions camelCase, constants UPPER_SNAKE>
- Imports: <relative vs alias, ordering>
- Error handling: <throw typed errors / return Result / never swallow errors>
- Comments: <only explain why; no commented-out code>

## Frontend
- `data-testid` on every interactive or asserted element, kebab-case `page-section-element` (e.g. `login-form-submit-btn`, repeated items `cart-item-{id}-remove-btn`). Use the exact ids from `design.md`.
- Styling: <CSS modules / Tailwind / plain CSS file>
- State / data fetching: <...>
- Text content: <set via textContent / framework binding; never inject untrusted HTML>

## Backend
- API style: <REST JSON, paths, status codes, error body shape>
- Validation: <where and how>
- Data access / migrations: <...>

## Unit tests
- Runner: `<unit command>`; files `<*.test.js next to code | tests/unit/>`.
- Every new piece of logic gets tests: happy path, edge cases, error cases. No tests that only assert mocks were called.

## E2E tests (qa)
- Playwright in `tests/e2e/`, spec files `<*.spec.ts | *.spec.js | ...: the project's language>`, one per feature area, locate with `page.getByTestId(...)`.
- Comment above every `test()`: `// Ticket: <DEV-ID> (<TEST-ID>) — ACn: <what it checks>`.
- Arrange / Act / Assert visible in each test; no `waitForTimeout`; each test creates its own data.

## Git
- Branch per ticket: `ticket/<ID>` from `dev`. Commit message: `<ID>: <summary>`.
- Never push. Never commit secrets, build output or local config.
