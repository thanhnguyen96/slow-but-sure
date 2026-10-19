#!/usr/bin/env node
// simple-workflow (sw): ticket board, epic folders and merge tool. Zero dependencies.
// Usage: node .claude/skills/simple-workflow/scripts/sw.mjs <command> ...   (no args = help)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const STATUSES = ['todo', 'in-progress', 'ready-to-review', 'ready-to-test', 'done'];
const TYPES = ['FEAT', 'BUG', 'REF', 'INIT', 'TEST'];
const ROLES = ['pm', 'lead-dev', 'dev', 'lead-qa', 'qa', 'reviewer', 'user'];
const LEVELS = ['junior', 'middle', 'senior'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const AGENT_MODELS = ['haiku', 'sonnet', 'opus', 'fable', 'inherit'];
const FM_KEYS = ['id', 'type', 'title', 'epic', 'created', 'updated', 'status', 'assigner', 'assignee', 'level', 'branch', 'merge', 'depends_on', 'covers'];
const DEFAULT_CONFIG = {
  integrationBranch: 'dev',
  releaseBranch: 'master',
  web: true,
  commands: { unit: '', build: '', lint: '', e2e: 'npx playwright test --reporter=line', app: '' },
  // Commands `sw merge` runs on the merged result before committing it.
  mergeChecks: ['unit', 'build', 'lint'],
  // lead-qa and qa may write only here (hook-enforced).
  qaWritable: ['tests/e2e/**', 'playwright.config.*', 'docs/epics/*/qa-plan.md', 'tickets/*/TEST-*.md'],
  // lead-dev may not write here (hook-enforced): tests belong to dev and qa workers.
  leadDevBlocked: ['tests/**', '**/*.test.*', '**/*.spec.*', 'playwright.config.*'],
};
// Model + effort per subagent role and per worker level. Users edit .claude/simple-workflow.models.json.
// The PM is the main conversation: its model and effort are the user's own (/model, /effort).
const DEFAULT_MODELS = {
  'lead-dev': { model: 'sonnet', effort: 'xhigh' },
  'lead-qa': { model: 'sonnet', effort: 'xhigh' },
  reviewer: { model: 'opus', effort: 'medium' },
  levels: {
    junior: { model: 'haiku', effort: 'max' },
    middle: { model: 'sonnet', effort: 'xhigh' },
    senior: { model: 'opus', effort: 'medium' },
  },
};
const MODEL_ROWS = [
  ['lead-dev', (m) => m['lead-dev'], 'dev plan, dev tickets, review decisions'],
  ['lead-qa', (m) => m['lead-qa'], 'qa plan, TEST tickets, test review, regression'],
  ['reviewer', (m) => m.reviewer, 'reviews merged dev tickets, one per round'],
  ['junior', (m) => m.levels.junior, 'dev/qa workers, default level'],
  ['middle', (m) => m.levels.middle, 'workers on a ticket reopened once'],
  ['senior', (m) => m.levels.senior, 'workers on a ticket reopened 2+ times (cap)'],
];
const MODEL_NOTES = { haiku: 'fastest, cheapest', sonnet: 'balanced', opus: 'strongest reasoning', inherit: 'same as caller' };
const EFFORT_NOTES = { low: 'quick', medium: 'balanced', high: 'careful', xhigh: 'very careful', max: 'deepest, slowest' };
const SHORT_FLAGS = { e: 'epic', t: 'type', n: 'note', b: 'by', l: 'level', d: 'depends', c: 'covers' };
const LOCK_WAIT_MS = 15 * 60 * 1000;
const LOCK_STALE_MS = 30 * 60 * 1000;

const USAGE = `sw: simple-workflow board        (sw = node .claude/skills/simple-workflow/scripts/sw.mjs)

Tickets
  sw new <feat|bug|ref|init|test> "<title>" -e <epic> [-d ID,ID] [-c ID,ID] [-l level] [-b role]
  sw start <ID> [-l level]            todo -> in-progress, assignee dev (qa for TEST)
  sw merge <ID> [--no-checks]         worker: merge ticket/<ID> into dev, run checks, -> ready-to-review
                                      exit 2 = conflict, exit 3 = checks failed (nothing merged)
  sw approve <ID> ["note"]            lead: ready-to-review -> ready-to-test, cleans worktree + branch
  sw reject <ID> "<findings>"         lead: ready-to-review -> in-progress (same level, same worker)
  sw reopen <ID> "<context summary>"  back to in-progress, level +1 (junior -> middle -> senior)
  sw done <ID> [ID...]                lead-qa: ready-to-test -> done
  sw note <ID> "<text>"
  sw mv <ID> <status> [-n "note"]     manual move (PM override)
  sw ls [status] [-e epic] [-t type]
  sw show <ID>
  sw clean                            remove worktrees/branches of approved tickets

Epics
  sw epic new <slug>                  create docs/epics/<YYYYMMDD>-<slug>/
  sw epic [ls]                        list epics with ticket counts

Setup
  sw init | sw models [--json] | sw mode <on|off|status>

-b/--by defaults to the role that normally runs the command.
statuses: ${STATUSES.join(', ')}
roles: ${ROLES.join(', ')}   levels: ${LEVELS.join(', ')}`;

// ---------- process helpers ----------

let lockHeld = null;
process.on('exit', () => { if (lockHeld) fs.rmSync(lockHeld, { force: true }); });

function die(msg, code = 1) {
  console.error(`sw: ${msg}`);
  process.exit(code);
}

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let key;
    if (a.startsWith('--')) key = a.slice(2);
    else if (/^-[a-z]$/.test(a)) key = SHORT_FLAGS[a[1]] || a[1];
    else { pos.push(a); continue; }
    const next = argv[i + 1];
    if (next === undefined || /^--?[a-z]/.test(next)) { flags[key] = true; continue; }
    // repeated flags accumulate: -d A -d B == -d A,B
    flags[key] = typeof flags[key] === 'string' ? `${flags[key]},${next}` : next;
    i++;
  }
  return { pos, flags };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function today() {
  return now().slice(0, 10).replace(/-/g, '');
}

function slugify(s) {
  const slug = s.replace(/[đĐ]/g, 'd').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '');
  return slug || 'ticket';
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJSON(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

function rel(file) {
  return path.relative(MAIN, file).split(path.sep).join('/');
}

// ---------- git ----------

function git(args, cwd = MAIN) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryGit(args, cwd = MAIN) {
  try { return git(args, cwd); } catch { return null; }
}

function worktrees() {
  const out = tryGit(['worktree', 'list', '--porcelain'], process.cwd());
  if (!out) return [];
  const list = [];
  for (const block of out.split(/\n\s*\n/)) {
    const wt = {};
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) wt.path = path.resolve(line.slice(9));
      if (line.startsWith('branch ')) wt.branch = line.slice(7).replace(/^refs\/heads\//, '');
    }
    if (wt.path) list.push(wt);
  }
  return list;
}

// The board always lives in the main checkout, even when sw runs inside a worker's worktree.
function findMain() {
  if (process.env.SW_ROOT) return path.resolve(process.env.SW_ROOT);
  const wts = worktrees();
  if (wts.length) return wts[0].path;
  let d = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(d, 'tickets', 'config.json'))) return d;
    const parent = path.dirname(d);
    if (parent === d) return process.cwd();
    d = parent;
  }
}

const MAIN = findMain();
const IN_GIT = tryGit(['rev-parse', '--is-inside-work-tree']) === 'true';
const TICKETS = path.join(MAIN, 'tickets');
const EPICS = path.join(MAIN, 'docs', 'epics');
const COUNTERS = path.join(TICKETS, '.counters.json');
const FLAG = path.join(MAIN, '.claude', 'simple-workflow.on');
const MODELS_FILE = path.join(MAIN, '.claude', 'simple-workflow.models.json');
const README_TEMPLATE = new URL('../templates/tickets-README.md', import.meta.url);

function config() {
  const c = readJSON(path.join(TICKETS, 'config.json'), {});
  return { ...DEFAULT_CONFIG, ...c, commands: { ...DEFAULT_CONFIG.commands, ...(c.commands || {}) } };
}

// One writer at a time across the main checkout and every worktree.
function lock() {
  if (!IN_GIT) return;
  const file = path.resolve(MAIN, git(['rev-parse', '--git-common-dir']), 'sw.lock');
  const start = Date.now();
  let told = false;
  for (;;) {
    try {
      fs.writeFileSync(file, `${process.pid} ${new Date().toISOString()} ${process.argv.slice(2).join(' ')}\n`, { flag: 'wx' });
      lockHeld = file;
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0;
      try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { continue; }
      if (age > LOCK_STALE_MS) { fs.rmSync(file, { force: true }); continue; }
      if (Date.now() - start > LOCK_WAIT_MS) die(`board is locked by: ${fs.readFileSync(file, 'utf8').trim()} (${file})`);
      if (!told) { console.log(`waiting for board lock (${fs.readFileSync(file, 'utf8').trim()})`); told = true; }
      sleep(1000);
    }
  }
}

function guardMain(flags, { clean = false } = {}) {
  if (!IN_GIT || flags['no-commit']) return;
  const branch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  const want = config().integrationBranch;
  if (branch !== want) die(`the main checkout (${MAIN}) is on '${branch}', not '${want}'. Board changes and merges happen on '${want}'.`);
  if (fs.existsSync(path.resolve(MAIN, git(['rev-parse', '--git-dir']), 'MERGE_HEAD'))) die('a merge is already in progress in the main checkout');
  if (clean) {
    const dirty = git(['status', '--porcelain', '--untracked-files=no']);
    if (dirty) die(`the main checkout has uncommitted changes; the lead must commit or stash them first:\n${dirty}`);
  }
}

function commitFiles(files, msg, flags) {
  if (flags['no-commit'] || !IN_GIT) return;
  const paths = [...new Set(files)].map(rel);
  try {
    git(['add', '-A', '--', ...paths]);
    git(['commit', '-q', '-m', msg, '--', ...paths]);
  } catch (e) {
    die(`git commit failed: ${String(e.stderr || e.message).trim()}`);
  }
}

// ---------- tickets ----------

function role(r) {
  if (!ROLES.includes(r)) die(`unknown role '${r}'. roles: ${ROLES.join(', ')}`);
  return r;
}

function level(l) {
  if (!LEVELS.includes(l)) die(`unknown level '${l}'. levels: ${LEVELS.join(', ')}`);
  return l;
}

function idList(v) {
  if (typeof v !== 'string') return '';
  const ids = v.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const bad = ids.filter((id) => !new RegExp(`^(${TYPES.join('|')})-\\d{4}$`).test(id));
  if (bad.length) die(`invalid ticket id(s): ${bad.join(', ')}. Use full ids like FEAT-0001.`);
  return ids.join(', ');
}

const leadOf = (type) => (type === 'TEST' ? 'lead-qa' : 'lead-dev');
const workerOf = (type) => (type === 'TEST' ? 'qa' : 'dev');

function by(flags, fallback) {
  return typeof flags.by === 'string' ? role(flags.by) : fallback;
}

function parseTicket(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) die(`no frontmatter in ${file}`);
  const fm = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { fm, body: text.slice(m[0].length) };
}

function renderTicket(fm, body) {
  const keys = [...FM_KEYS, ...Object.keys(fm).filter((k) => !FM_KEYS.includes(k))];
  return `---\n${keys.map((k) => `${k}: ${fm[k] ?? ''}`.trimEnd()).join('\n')}\n---\n${body}`;
}

function appendHistory(body, line) {
  return body.replace(/\s*$/, '\n') + `- ${line}\n`;
}

function allTickets() {
  const out = [];
  for (const status of STATUSES) {
    const dir = path.join(TICKETS, status);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^([A-Z]+-\d+).*\.md$/);
      if (m) out.push({ status, file: path.join(dir, f), id: m[1] });
    }
  }
  return out;
}

function findTicket(id) {
  if (!id) die('ticket id required');
  const t = allTickets().find((x) => x.id === id.toUpperCase());
  if (!t) die(`ticket ${id} not found in ${rel(TICKETS)}/`);
  return { ...t, ...parseTicket(t.file) };
}

// Writes the ticket to its new status folder and returns [old, new] paths for the commit.
function moveTicket(t, to, line, fmChanges = {}) {
  const fm = { ...t.fm, ...fmChanges, status: to, updated: now() };
  const dest = path.join(TICKETS, to, path.basename(t.file));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(t.file, renderTicket(fm, appendHistory(t.body, `${fm.updated} — ${line}`)));
  if (dest !== t.file) fs.renameSync(t.file, dest);
  return [t.file, dest];
}

function needStatus(t, ...allowed) {
  if (!allowed.includes(t.status)) die(`${t.id} is in ${t.status}; this command needs ${allowed.join(' or ')}`);
}

function ticketTemplate(id, title, epic) {
  return `
# ${id}: ${title}

## Context
${epic ? `Epic: docs/epics/${epic}/ (brief.md, design.md, plan.md, dev-plan.md / qa-plan.md)\n` : ''}<!-- why this ticket exists; which sections of the epic docs it implements -->

## Scope
- In:
- Out (don't touch):

## Contracts
<!-- interfaces this ticket provides or relies on (API shapes, function signatures) that other tickets use -->

## Acceptance criteria
- [ ] AC1:

## data-testid
| Page | Element | data-testid |
|---|---|---|

## History
`;
}

// ---------- epic logs ----------

function epicLog(epic, name, header) {
  const dir = epic ? path.join(EPICS, epic) : TICKETS;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, header);
  return file;
}

const MERGES_HEADER = `# Merges

Written by \`sw merge\`. One row per merge of a ticket branch into dev. Review a row with \`git show <merge>\` (or \`git diff <merge>^1 <merge>\`).

| Time | Ticket | Title | Branch | Branch head | Merge commit | By |
|---|---|---|---|---|---|---|
`;
const REVIEWS_HEADER = `# Reviews

Written by \`sw approve\` and \`sw reject\`.

| Time | Ticket | Merge commit | Verdict | By | Note |
|---|---|---|---|---|---|
`;

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

// ---------- commands: tickets ----------

function cmdInit() {
  for (const status of STATUSES) {
    fs.mkdirSync(path.join(TICKETS, status), { recursive: true });
    const keep = path.join(TICKETS, status, '.gitkeep');
    if (!fs.existsSync(keep)) fs.writeFileSync(keep, '');
  }
  fs.mkdirSync(EPICS, { recursive: true });
  const cfg = path.join(TICKETS, 'config.json');
  if (!fs.existsSync(cfg)) writeJSON(cfg, DEFAULT_CONFIG);
  else {
    // Config from the old slow-but-sure name: keep the user's commands, add the new keys.
    const c = readJSON(cfg, {});
    if (c.testerWritable || !c.qaWritable || !c.leadDevBlocked || !c.mergeChecks) {
      delete c.testerWritable;
      writeJSON(cfg, { ...DEFAULT_CONFIG, ...c, commands: { ...DEFAULT_CONFIG.commands, ...(c.commands || {}) } });
      console.log(`updated ${rel(cfg)} (qaWritable, leadDevBlocked, mergeChecks)`);
    }
  }
  if (!fs.existsSync(COUNTERS)) writeJSON(COUNTERS, {});
  // Generated file: always refreshed so it matches this version of the flow.
  if (fs.existsSync(README_TEMPLATE)) fs.copyFileSync(README_TEMPLATE, path.join(TICKETS, 'README.md'));
  console.log(`board ready: ${rel(TICKETS) || '.'} (${STATUSES.join(', ')}); epics in ${rel(EPICS)}/`);
}

function cmdNew(pos, flags) {
  const type = (pos[0] || '').toUpperCase();
  const title = pos.slice(1).join(' ').trim();
  if (!TYPES.includes(type)) die(`type must be one of ${TYPES.map((t) => t.toLowerCase()).join('|')}`);
  if (!title) die('title required');
  if (type === 'TEST' && typeof flags.covers !== 'string') die('TEST tickets need -c <ID[,ID]> (the dev tickets they cover)');
  if (!fs.existsSync(TICKETS)) die('no tickets/ here; run `sw init` first');
  const epic = typeof flags.epic === 'string' ? flags.epic : '';
  if (epic && !fs.existsSync(path.join(EPICS, epic))) die(`epic folder docs/epics/${epic}/ does not exist (see \`sw epic\`)`);
  const who = by(flags, leadOf(type));
  lock();
  guardMain(flags);

  const counters = readJSON(COUNTERS, {});
  const used = allTickets().filter((t) => t.id.startsWith(`${type}-`)).map((t) => Number(t.id.split('-')[1]));
  const n = Math.max(counters[type] || 0, 0, ...used) + 1;
  counters[type] = n;
  const id = `${type}-${String(n).padStart(4, '0')}`;
  const ts = now();
  const fm = {
    id, type, title, epic,
    created: ts, updated: ts, status: 'todo',
    assigner: who, assignee: '',
    level: typeof flags.level === 'string' ? level(flags.level) : 'junior',
    branch: `ticket/${id}`, merge: '',
    depends_on: idList(flags.depends),
    covers: idList(flags.covers),
  };
  const file = path.join(TICKETS, 'todo', `${id}-${slugify(title)}.md`);
  fs.writeFileSync(file, renderTicket(fm, ticketTemplate(id, title, epic) + `- ${ts} — created in todo by ${who}\n`));
  writeJSON(COUNTERS, counters);
  commitFiles([file, COUNTERS], `board: create ${id} ${title}`, flags);
  console.log(rel(file));
}

function cmdStart(pos, flags) {
  const t = findTicket(pos[0]);
  needStatus(t, 'todo');
  const who = by(flags, leadOf(t.fm.type));
  const assignee = workerOf(t.fm.type);
  const lvl = typeof flags.level === 'string' ? level(flags.level) : (t.fm.level || 'junior');
  lock();
  guardMain(flags);
  const files = moveTicket(t, 'in-progress', `todo -> in-progress by ${who} (assignee: ${assignee}, level ${lvl})`, { assignee, level: lvl });
  commitFiles(files, `board: ${t.id} todo -> in-progress`, flags);
  console.log(`${t.id}: todo -> in-progress  assignee: ${assignee}  level: ${lvl}  branch: ${t.fm.branch}`);
}

function runCheck(name, cmd) {
  const r = spawnSync(cmd, { cwd: MAIN, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { name, cmd, ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`, status: r.status };
}

function cmdMerge(pos, flags) {
  if (!IN_GIT) die('sw merge needs a git repository');
  const id = pos[0];
  const here = path.resolve(git(['rev-parse', '--show-toplevel'], process.cwd()));
  lock();
  guardMain(flags, { clean: true });
  const t = findTicket(id);
  needStatus(t, 'in-progress');
  const cfg = config();
  const dev = cfg.integrationBranch;
  const branch = t.fm.branch || `ticket/${t.id}`;
  const who = by(flags, workerOf(t.fm.type));
  if (!tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) die(`branch ${branch} does not exist`);

  // Uncommitted work in the worktree that owns the branch would silently be left out.
  const owner = worktrees().find((w) => w.branch === branch);
  for (const dir of new Set([owner?.path, here !== MAIN ? here : null].filter(Boolean))) {
    const dirty = git(['status', '--porcelain', '--untracked-files=no'], dir);
    if (dirty) die(`uncommitted changes in ${dir}; commit them on ${branch} first:\n${dirty}`);
  }
  const head = git(['rev-parse', '--short', branch]);
  if (git(['rev-list', '--count', `${dev}..${branch}`]) === '0') die(`${branch} has no commits that are not in ${dev}; nothing to merge`);

  const title = t.fm.title;
  const m = spawnSync('git', ['merge', '--no-ff', '--no-commit', branch], { cwd: MAIN, encoding: 'utf8' });
  if (m.status !== 0) {
    const conflicts = tryGit(['diff', '--name-only', '--diff-filter=U']) || '';
    tryGit(['merge', '--abort']);
    console.error(`sw: CONFLICT merging ${branch} into ${dev}. Nothing was merged; ${dev} is unchanged.`);
    if (conflicts) console.error(`conflicting files:\n${conflicts.split('\n').map((f) => `  ${f}`).join('\n')}`);
    else console.error((m.stdout + m.stderr).trim());
    console.error(`fix: in your worktree run \`git merge ${dev}\`, resolve the conflicts, run the unit/build/lint commands, commit, then run \`sw merge ${t.id}\` again.`);
    process.exit(2);
  }

  if (!flags['no-checks']) {
    for (const name of cfg.mergeChecks || []) {
      const cmd = cfg.commands[name];
      if (!cmd) continue;
      process.stdout.write(`check ${name}: ${cmd} ... `);
      const r = runCheck(name, cmd);
      console.log(r.ok ? 'PASS' : `FAIL (exit ${r.status})`);
      if (!r.ok) {
        tryGit(['merge', '--abort']);
        const tail = r.out.trim().split('\n').slice(-40).join('\n');
        console.error(`sw: ${name} failed on the merged result. Nothing was merged; ${dev} is unchanged.\n--- last lines of \`${cmd}\` ---\n${tail}`);
        console.error(`fix: in your worktree run \`git merge ${dev}\`, run \`${cmd}\` until it passes, commit, then run \`sw merge ${t.id}\` again.`);
        process.exit(3);
      }
    }
  }

  // The merge commit carries the ticket move, so dev never shows merged code under a stale status.
  const moved = moveTicket(t, 'ready-to-review', `in-progress -> ready-to-review by ${who}: merged ${branch}@${head} into ${dev}`);
  git(['add', '-A', '--', ...moved.map(rel)]);
  git(['commit', '-q', '-m', `merge ${t.id}: ${title}`]);
  const merge = git(['rev-parse', '--short', 'HEAD']);

  const log = epicLog(t.fm.epic, 'merges.md', MERGES_HEADER);
  fs.appendFileSync(log, `| ${now()} | ${t.id} | ${cell(title)} | ${branch} | ${head} | ${merge} | ${who} |\n`);
  const after = findTicket(t.id);
  fs.writeFileSync(after.file, renderTicket({ ...after.fm, merge }, after.body));
  commitFiles([log, after.file], `board: ${t.id} merged as ${merge}`, flags);

  console.log(`${t.id}: merged ${branch}@${head} into ${dev} as ${merge}; status ready-to-review.`);
  console.log(`report to your lead: "${t.id} merged as ${merge}". Keep your worktree until the review is approved.`);
}

function cmdApprove(pos, flags) {
  const t = findTicket(pos[0]);
  needStatus(t, 'ready-to-review');
  const note = pos.slice(1).join(' ').trim();
  const who = by(flags, leadOf(t.fm.type));
  lock();
  guardMain(flags);
  const files = moveTicket(t, 'ready-to-test', `ready-to-review -> ready-to-test by ${who}: review approved (merge ${t.fm.merge || '?'})${note ? `: ${note}` : ''}`);
  const log = epicLog(t.fm.epic, 'reviews.md', REVIEWS_HEADER);
  fs.appendFileSync(log, `| ${now()} | ${t.id} | ${t.fm.merge || ''} | approved | ${who} | ${cell(note)} |\n`);
  commitFiles([...files, log], `board: ${t.id} approved`, flags);
  console.log(`${t.id}: ready-to-review -> ready-to-test`);
  cleanupTicket(t.fm.branch);
}

function cmdReject(pos, flags) {
  const t = findTicket(pos[0]);
  needStatus(t, 'ready-to-review');
  const findings = pos.slice(1).join(' ').trim();
  if (!findings) die(`usage: sw reject ${t.id} "<findings: file:line, what is wrong, what to do>"`);
  const who = by(flags, leadOf(t.fm.type));
  lock();
  guardMain(flags);
  const files = moveTicket(t, 'in-progress', `ready-to-review -> in-progress by ${who}: review rejected (merge ${t.fm.merge || '?'}): ${findings}`);
  const log = epicLog(t.fm.epic, 'reviews.md', REVIEWS_HEADER);
  fs.appendFileSync(log, `| ${now()} | ${t.id} | ${t.fm.merge || ''} | changes requested | ${who} | ${cell(findings)} |\n`);
  commitFiles([...files, log], `board: ${t.id} review rejected`, flags);
  console.log(`${t.id}: ready-to-review -> in-progress (level ${t.fm.level || 'junior'}). Send the findings to the same worker; it fixes on ${t.fm.branch} and runs \`sw merge ${t.id}\` again.`);
}

function cmdReopen(pos, flags) {
  const t = findTicket(pos[0]);
  if (t.status === 'todo') die(`${t.id} was never started; use \`sw start\``);
  const summary = pos.slice(1).join(' ').trim() || (typeof flags.note === 'string' ? flags.note : '');
  if (!summary) die(`usage: sw reopen ${t.id} "<context summary: what was expected, what failed (test, error, file:line), what was tried>"`);
  const who = by(flags, leadOf(t.fm.type));
  const prev = LEVELS.includes(t.fm.level) ? t.fm.level : 'junior';
  const next = typeof flags.level === 'string' ? level(flags.level) : LEVELS[Math.min(LEVELS.indexOf(prev) + 1, LEVELS.length - 1)];
  const assignee = workerOf(t.fm.type);
  lock();
  guardMain(flags);
  const files = moveTicket(t, 'in-progress', `${t.status} -> in-progress by ${who} (reopened, level ${prev} -> ${next}): ${summary}`, { level: next, assignee });
  commitFiles(files, `board: ${t.id} reopened`, flags);
  console.log(`${t.id}: ${t.status} -> in-progress (reopened)  level: ${prev} -> ${next}  branch: ${t.fm.branch}`);
}

function cmdDone(pos, flags) {
  if (!pos.length) die('usage: sw done <ID> [ID...]');
  const tickets = pos.map(findTicket);
  for (const t of tickets) needStatus(t, 'ready-to-test');
  const who = by(flags, 'lead-qa');
  lock();
  guardMain(flags);
  const files = tickets.flatMap((t) => moveTicket(t, 'done', `ready-to-test -> done by ${who}: regression passed`));
  commitFiles(files, `board: ${tickets.map((t) => t.id).join(', ')} done`, flags);
  for (const t of tickets) console.log(`${t.id}: ready-to-test -> done`);
}

function cmdNote(pos, flags) {
  const t = findTicket(pos[0]);
  const text = pos.slice(1).join(' ').trim();
  if (!text) die(`usage: sw note ${t.id} "<text>"`);
  const who = by(flags, leadOf(t.fm.type));
  lock();
  guardMain(flags);
  const ts = now();
  fs.writeFileSync(t.file, renderTicket({ ...t.fm, updated: ts }, appendHistory(t.body, `${ts} — note by ${who}: ${text}`)));
  commitFiles([t.file], `board: ${t.id} note`, flags);
  console.log(`${t.id}: note added`);
}

function cmdMv(pos, flags) {
  const t = findTicket(pos[0]);
  const to = pos[1];
  if (!STATUSES.includes(to)) die(`usage: sw mv <ID> <${STATUSES.join('|')}> [-n "note"]`);
  const who = by(flags, 'pm');
  const changes = typeof flags.level === 'string' ? { level: level(flags.level) } : {};
  lock();
  guardMain(flags);
  const note = typeof flags.note === 'string' ? `: ${flags.note}` : '';
  const files = moveTicket(t, to, `${t.status} -> ${to} by ${who} (manual)${note}`, changes);
  commitFiles(files, `board: ${t.id} ${t.status} -> ${to}`, flags);
  console.log(`${t.id}: ${t.status} -> ${to}`);
}

function cmdLs(pos, flags) {
  if (pos[0] && !STATUSES.includes(pos[0])) die(`status must be one of ${STATUSES.join('|')}`);
  const rows = allTickets()
    .filter((t) => !pos[0] || t.status === pos[0])
    .map((t) => ({ ...parseTicket(t.file).fm, status: t.status }))
    .filter((r) => typeof flags.epic !== 'string' || r.epic === flags.epic)
    .filter((r) => typeof flags.type !== 'string' || r.type === flags.type.toUpperCase());
  if (!rows.length) return console.log('(no tickets)');
  for (const status of STATUSES) {
    const group = rows.filter((r) => r.status === status);
    if (!group.length) continue;
    console.log(`\n${status} (${group.length})`);
    for (const r of group) {
      const extra = (r.merge ? `  [merge ${r.merge}]` : '') + (r.covers ? `  [covers ${r.covers}]` : '') + (r.depends_on ? `  [after ${r.depends_on}]` : '');
      const who = `${r.assignee || '-'}/${r.level || 'junior'}`;
      console.log(`  ${r.id.padEnd(10)} ${who.padEnd(14)} ${r.title}${extra}`);
    }
  }
}

function cmdShow(pos) {
  const t = findTicket(pos[0]);
  console.log(`# ${rel(t.file)}\n`);
  console.log(fs.readFileSync(t.file, 'utf8').replace(/\r\n/g, '\n').trimEnd());
}

// Removes the ticket's worktree and merged branch, plus empty worktree-agent-* branches. Best effort.
function cleanupTicket(branch) {
  if (!IN_GIT || !branch) return;
  const dev = config().integrationBranch;
  for (const wt of worktrees().filter((w) => w.branch === branch && w.path !== MAIN)) {
    if (tryGit(['worktree', 'remove', wt.path]) === null) console.log(`  could not remove worktree ${wt.path} (dirty or in use); remove it later with \`sw clean\``);
    else console.log(`  removed worktree ${wt.path}`);
  }
  tryGit(['worktree', 'prune']);
  const merged = (tryGit(['branch', '--merged', dev, '--format=%(refname:short)']) || '').split('\n').filter(Boolean);
  const checkedOut = new Set(worktrees().map((w) => w.branch));
  for (const b of merged) {
    if (checkedOut.has(b)) continue;
    if (b === branch || /^worktree-agent-/.test(b)) {
      if (tryGit(['branch', '-d', b]) !== null) console.log(`  deleted branch ${b}`);
    }
  }
}

function cmdClean() {
  const approved = allTickets().filter((t) => t.status === 'ready-to-test' || t.status === 'done');
  for (const t of approved) cleanupTicket(parseTicket(t.file).fm.branch);
  cleanupTicket('');
  const left = worktrees().slice(1);
  console.log(left.length ? `worktrees still present:\n${left.map((w) => `  ${w.path} [${w.branch || 'detached'}]`).join('\n')}` : 'no linked worktrees left');
}

// ---------- commands: epics ----------

const EPIC_FILES = {
  'brief.md': (name) => `# Brief: ${name}\n\n<!-- PM: goal, users, scope in/out, edge cases, acceptance criteria, what "done" means -->\n`,
  'design.md': (name) => `# Design: ${name}\n\n<!-- PM: every page with its elements and data-testid; links to mockups/ -->\n`,
  'plan.md': (name) => `# Plan: ${name}\n\n<!-- PM: system design (Backend / Frontend / Automation test) and the rough implementation plan -->\n`,
};

function cmdEpic(pos) {
  const sub = pos[0] || 'ls';
  if (sub === 'new') {
    const slug = slugify(pos.slice(1).join(' '));
    if (!pos[1]) die('usage: sw epic new <slug>');
    const name = `${today()}-${slug}`;
    const dir = path.join(EPICS, name);
    if (fs.existsSync(dir)) die(`docs/epics/${name}/ already exists`);
    fs.mkdirSync(path.join(dir, 'mockups'), { recursive: true });
    for (const [file, body] of Object.entries(EPIC_FILES)) fs.writeFileSync(path.join(dir, file), body(name));
    console.log(`created ${rel(dir)}/ (${Object.keys(EPIC_FILES).join(', ')}, mockups/)`);
    console.log(`epic name: ${name}`);
    return;
  }
  if (sub !== 'ls') die('usage: sw epic new <slug> | sw epic ls');
  if (!fs.existsSync(EPICS)) return console.log('(no epics)');
  const tickets = allTickets().map((t) => ({ ...parseTicket(t.file).fm, status: t.status }));
  const names = fs.readdirSync(EPICS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  if (!names.length) return console.log('(no epics)');
  for (const name of names) {
    const mine = tickets.filter((t) => t.epic === name);
    const counts = STATUSES.map((s) => [s, mine.filter((t) => t.status === s).length]).filter(([, n]) => n).map(([s, n]) => `${s} ${n}`);
    console.log(`  ${name.padEnd(40)} ${counts.join(', ') || 'no tickets'}`);
  }
}

// ---------- commands: models, mode ----------

function loadModels() {
  if (!fs.existsSync(MODELS_FILE)) {
    fs.mkdirSync(path.dirname(MODELS_FILE), { recursive: true });
    writeJSON(MODELS_FILE, DEFAULT_MODELS);
    console.log(`created ${rel(MODELS_FILE)} (edit it to change models/effort)`);
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8')); } catch (e) { die(`cannot parse ${MODELS_FILE}: ${e.message}`); }
  const m = {
    'lead-dev': raw['lead-dev'] || DEFAULT_MODELS['lead-dev'],
    'lead-qa': raw['lead-qa'] || DEFAULT_MODELS['lead-qa'],
    reviewer: raw.reviewer || DEFAULT_MODELS.reviewer,
    levels: { ...DEFAULT_MODELS.levels, ...(raw.levels || {}) },
  };
  for (const [name, get] of MODEL_ROWS) {
    const v = get(m) || {};
    if (!AGENT_MODELS.includes(v.model)) die(`${name}.model '${v.model}' invalid in ${MODELS_FILE}. Use one of ${AGENT_MODELS.join(', ')}`);
    if (!EFFORTS.includes(v.effort)) die(`${name}.effort '${v.effort}' invalid. Use one of ${EFFORTS.join(', ')}`);
  }
  return m;
}

function printModels(m) {
  console.log(`simple-workflow models (${rel(MODELS_FILE)})`);
  console.log(`  ${'ROLE'.padEnd(12)} ${'MODEL'.padEnd(26)} ${'EFFORT'.padEnd(26)} USED FOR`);
  for (const [name, get, use] of MODEL_ROWS) {
    const v = get(m);
    const model = `${v.model}${MODEL_NOTES[v.model] ? ` (${MODEL_NOTES[v.model]})` : ''}`;
    const effort = `${v.effort} (${EFFORT_NOTES[v.effort]})`;
    console.log(`  ${name.padEnd(12)} ${model.padEnd(26)} ${effort.padEnd(26)} ${use}`);
  }
  console.log('  Workers start at junior; each reopen of a ticket raises it one level, up to senior.');
}

function cmdModels(flags) {
  const m = loadModels();
  if (flags.json) return console.log(JSON.stringify(m, null, 2));
  printModels(m);
}

function cmdMode(pos) {
  const v = pos[0] || 'status';
  if (v === 'on') {
    fs.mkdirSync(path.dirname(FLAG), { recursive: true });
    if (!fs.existsSync(FLAG)) fs.writeFileSync(FLAG, `enabled ${now()}\n`);
    printModels(loadModels());
  } else if (v === 'off') {
    fs.rmSync(FLAG, { force: true });
  } else if (v !== 'status') {
    die('usage: sw mode <on|off|status>');
  }
  console.log(`simple-workflow: ${fs.existsSync(FLAG) ? 'ON' : 'OFF'}`);
}

const { pos, flags } = parseArgs(process.argv.slice(2));
const cmd = pos.shift();
const COMMANDS = {
  init: cmdInit, new: cmdNew, start: cmdStart, merge: cmdMerge, approve: cmdApprove, reject: cmdReject,
  reopen: cmdReopen, done: cmdDone, note: cmdNote, mv: cmdMv, ls: cmdLs, list: cmdLs, show: cmdShow,
  clean: cmdClean, epic: cmdEpic, models: cmdModels, mode: cmdMode,
};
if (!COMMANDS[cmd]) {
  console.log(USAGE);
  process.exit(cmd && cmd !== 'help' ? 1 : 0);
}
COMMANDS[cmd](pos, flags);
