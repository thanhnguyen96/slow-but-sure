// Shared constants and defaults.

export const STATUSES = ['todo', 'in-progress', 'ready-to-review', 'ready-to-test', 'done'];
export const TYPES = ['FEAT', 'BUG', 'REF', 'INIT', 'TEST'];
export const ROLES = ['pm', 'lead-dev', 'dev', 'lead-qa', 'qa', 'reviewer', 'user'];
export const LEVELS = ['junior', 'middle', 'senior'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const AGENT_MODELS = ['haiku', 'sonnet', 'opus', 'fable', 'inherit'];
export const FM_KEYS = ['id', 'type', 'title', 'epic', 'created', 'updated', 'status', 'assigner', 'assignee', 'level', 'branch', 'merge', 'depends_on', 'covers'];
export const DEFAULT_CONFIG = {
  integrationBranch: 'dev',
  releaseBranch: 'master',
  web: true,
  // setup: installs dependencies in a fresh worktree (e.g. npm ci); workers run it first.
  commands: { setup: '', unit: '', build: '', lint: '', e2e: 'npx playwright test --reporter=line', app: '' },
  // Commands `sbs merge` runs on the merged result before committing it.
  mergeChecks: ['unit', 'build', 'lint'],
  // lead-qa and qa may write only here (hook-enforced).
  qaWritable: ['tests/e2e/**', 'playwright.config.*', 'docs/epics/*/qa-plan.md', 'docs/epics/*/screenshots/**', 'tickets/*/TEST-*.md'],
  // lead-dev may not write here (hook-enforced): tests belong to dev and qa workers.
  leadDevBlocked: ['tests/**', '**/*.test.*', '**/*.spec.*', 'playwright.config.*'],
  // dev workers may not write here (hook-enforced): the board changes only through sbs, docs belong to the PM and leads.
  devBlocked: ['tickets/**', 'docs/epics/**', 'docs/rules/**'],
  // Tool calls per dev/qa worker (hook-enforced): from warn it is told to wrap up, from stop only git and sbs run.
  workerCallBudget: { warn: 60, stop: 90 },
};
// Model + effort per subagent role and per worker level. Users edit .claude/slow-but-sure.models.json.
// The PM is the main conversation: its model and effort are the user's own (/model, /effort).
export const DEFAULT_MODELS = {
  'lead-dev': { model: 'sonnet', effort: 'medium' },
  'lead-qa': { model: 'sonnet', effort: 'medium' },
  reviewer: { model: 'opus', effort: 'medium' },
  levels: {
    junior: { model: 'haiku', effort: 'medium' },
    middle: { model: 'sonnet', effort: 'medium' },
    senior: { model: 'opus', effort: 'medium' },
  },
};
export const MODEL_ROWS = [
  ['lead-dev', (m) => m['lead-dev'], 'dev plan, dev tickets, review decisions'],
  ['lead-qa', (m) => m['lead-qa'], 'qa plan, TEST tickets, test review, regression'],
  ['reviewer', (m) => m.reviewer, 'reviews each batch of merged dev tickets'],
  ['junior', (m) => m.levels.junior, 'dev/qa workers, default level'],
  ['middle', (m) => m.levels.middle, 'workers on a ticket reopened once'],
  ['senior', (m) => m.levels.senior, 'workers on a ticket reopened 2+ times (cap)'],
];
export const MODEL_NOTES = { haiku: 'fastest, cheapest', sonnet: 'balanced', opus: 'strongest reasoning', inherit: 'same as caller' };
export const EFFORT_NOTES = { low: 'quick', medium: 'balanced', high: 'careful', xhigh: 'very careful', max: 'deepest, slowest' };
export const DIRTY_WAIT_S = 30;
export const LOCK_WAIT_MS = 15 * 60 * 1000;
export const LOCK_STALE_MS = 30 * 60 * 1000;
