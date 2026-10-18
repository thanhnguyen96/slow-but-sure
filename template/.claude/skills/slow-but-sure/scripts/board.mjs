#!/usr/bin/env node
// slow-but-sure ticket board. Zero dependencies.
// Usage: node .claude/skills/slow-but-sure/scripts/board.mjs <init|new|move|note|list|mode> ...
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const STATUSES = ['todo', 'in-progress', 'ready-to-test', 'done'];
const TYPES = ['FEAT', 'BUG', 'REF', 'INIT', 'TEST'];
const ROLES = ['pm', 'senior-dev', 'junior-dev', 'senior-tester', 'junior-tester', 'user'];
const FM_KEYS = ['id', 'type', 'title', 'epic', 'created', 'updated', 'status', 'assigner', 'assignee', 'branch', 'depends_on', 'covers'];
const DEFAULT_CONFIG = {
  integrationBranch: 'dev',
  releaseBranch: 'master',
  web: true,
  commands: { unit: '', build: '', lint: '', e2e: 'npx playwright test', app: '' },
  testerWritable: ['tests/e2e/**', 'playwright.config.*', 'docs/specs/*/test-plan.md', 'tickets/*/TEST-*.md'],
};

const USAGE = `usage:
  board init
  board new <${TYPES.join('|')}> "<title>" --by <role> [--epic <dir>] [--assignee <role>] [--depends ID,ID] [--covers ID,ID] [--no-commit]
  board move <ID> <${STATUSES.join('|')}> --by <role> [--assignee <role>] [--note "..."] [--no-commit]
  board note <ID> "<text>" --by <role> [--no-commit]
  board list [status] [--epic <dir>] [--type <TYPE>]
  board mode <on|off|status>
roles: ${ROLES.join(', ')}`;

function die(msg) {
  console.error(`board: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[a.slice(2)] = true;
    else { flags[a.slice(2)] = next; i++; }
  }
  return { pos, flags };
}

function findRoot() {
  if (process.env.SBS_ROOT) return path.resolve(process.env.SBS_ROOT);
  let d = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(d, 'tickets', 'config.json')) || fs.existsSync(path.join(d, '.git'))) return d;
    const parent = path.dirname(d);
    if (parent === d) return process.cwd();
    d = parent;
  }
}

const ROOT = findRoot();
const TICKETS = path.join(ROOT, 'tickets');
const COUNTERS = path.join(TICKETS, '.counters.json');
const FLAG = path.join(ROOT, '.claude', 'slow-but-sure.on');

function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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

function config() {
  const c = readJSON(path.join(TICKETS, 'config.json'), {});
  return { ...DEFAULT_CONFIG, ...c, commands: { ...DEFAULT_CONFIG.commands, ...(c.commands || {}) } };
}

function role(r) {
  if (!ROLES.includes(r)) die(`unknown role '${r}'. roles: ${ROLES.join(', ')}`);
  return r;
}

function idList(v) {
  if (typeof v !== 'string') return '';
  return v.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).join(', ');
}

// ---------- ticket files ----------

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
  const t = allTickets().find((x) => x.id === id.toUpperCase());
  if (!t) die(`ticket ${id} not found`);
  return t;
}

function ticketTemplate(id, title, epic) {
  return `
# ${id}: ${title}

## Context
${epic ? `Epic: docs/specs/${epic}/\n` : ''}<!-- why this ticket exists; link brief/design/system-design sections -->

## Scope
- In:
- Out:

## Acceptance criteria
- [ ] AC1:

## data-testid
| Page | Element | data-testid |
|---|---|---|

## History
`;
}

// ---------- git ----------

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function inGit() {
  try { return git(['rev-parse', '--is-inside-work-tree']) === 'true'; } catch { return false; }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Board changes happen only in the main checkout, on the integration branch.
function guardWrite(flags) {
  if (!inGit()) return;
  const gitDir = path.resolve(ROOT, git(['rev-parse', '--git-dir']));
  const commonDir = path.resolve(ROOT, git(['rev-parse', '--git-common-dir']));
  if (gitDir !== commonDir) die('this is a linked worktree; the board is changed only in the main checkout');
  if (flags['no-commit']) return;
  let branch;
  try { branch = git(['rev-parse', '--abbrev-ref', 'HEAD']); } catch { return; }
  const want = config().integrationBranch;
  if (branch !== want) die(`board changes are committed on '${want}' but HEAD is '${branch}'. Switch branch or pass --no-commit.`);
}

function commit(files, msg, flags) {
  if (flags['no-commit'] || !inGit()) return;
  const rel = [...new Set(files)].map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
  for (let attempt = 0; ; attempt++) {
    try {
      git(['add', '-A', '--', ...rel]);
      git(['commit', '-q', '-m', msg, '--', ...rel]);
      return;
    } catch (e) {
      const err = String(e.stderr || e.message);
      if (/index\.lock/.test(err) && attempt < 10) { sleep(500); continue; }
      die(`git commit failed: ${err.trim()}`);
    }
  }
}

// ---------- commands ----------

function cmdInit() {
  for (const status of STATUSES) {
    fs.mkdirSync(path.join(TICKETS, status), { recursive: true });
    const keep = path.join(TICKETS, status, '.gitkeep');
    if (!fs.existsSync(keep)) fs.writeFileSync(keep, '');
  }
  const cfg = path.join(TICKETS, 'config.json');
  if (!fs.existsSync(cfg)) writeJSON(cfg, DEFAULT_CONFIG);
  if (!fs.existsSync(COUNTERS)) writeJSON(COUNTERS, {});
  console.log(`board ready: ${path.relative(process.cwd(), TICKETS) || '.'} (${STATUSES.join(', ')})`);
}

function cmdNew(pos, flags) {
  const type = (pos[0] || '').toUpperCase();
  const title = pos.slice(1).join(' ').trim();
  if (!TYPES.includes(type)) die(`type must be one of ${TYPES.join('|')}`);
  if (!title) die('title required');
  if (typeof flags.by !== 'string') die('--by <role> required');
  const by = role(flags.by);
  if (type === 'TEST' && typeof flags.covers !== 'string') die('TEST tickets need --covers <ID[,ID]>');
  if (!fs.existsSync(TICKETS)) die('no tickets/ here; run `board init` first');
  guardWrite(flags);

  const counters = readJSON(COUNTERS, {});
  const used = allTickets().filter((t) => t.id.startsWith(`${type}-`)).map((t) => Number(t.id.split('-')[1]));
  const n = Math.max(counters[type] || 0, 0, ...used) + 1;
  counters[type] = n;
  const id = `${type}-${String(n).padStart(4, '0')}`;
  const ts = now();
  const epic = typeof flags.epic === 'string' ? flags.epic : '';
  const fm = {
    id, type, title, epic,
    created: ts, updated: ts, status: 'todo',
    assigner: by,
    assignee: typeof flags.assignee === 'string' ? role(flags.assignee) : '',
    branch: `ticket/${id}`,
    depends_on: idList(flags.depends),
    covers: idList(flags.covers),
  };
  const file = path.join(TICKETS, 'todo', `${id}-${slugify(title)}.md`);
  fs.writeFileSync(file, renderTicket(fm, ticketTemplate(id, title, epic) + `- ${ts} — created in todo by ${by}\n`));
  writeJSON(COUNTERS, counters);
  commit([file, COUNTERS], `board: create ${id} ${title}`, flags);
  console.log(path.relative(ROOT, file).split(path.sep).join('/'));
}

function cmdMove(pos, flags) {
  const [id, to] = pos;
  if (!id || !STATUSES.includes(to)) die(`usage: move <ID> <${STATUSES.join('|')}> --by <role>`);
  if (typeof flags.by !== 'string') die('--by <role> required');
  const by = role(flags.by);
  guardWrite(flags);

  const t = findTicket(id);
  const { fm, body } = parseTicket(t.file);
  const ts = now();
  fm.status = to;
  fm.updated = ts;
  let line = `${ts} — ${t.status} -> ${to} by ${by}`;
  if (typeof flags.assignee === 'string') {
    fm.assignee = role(flags.assignee);
    line += ` (assignee: ${fm.assignee})`;
  }
  if (typeof flags.note === 'string') line += `: ${flags.note}`;
  const dest = path.join(TICKETS, to, path.basename(t.file));
  fs.writeFileSync(t.file, renderTicket(fm, appendHistory(body, line)));
  if (dest !== t.file) fs.renameSync(t.file, dest);
  commit([t.file, dest], `board: ${fm.id} ${t.status} -> ${to}`, flags);
  console.log(`${fm.id}: ${t.status} -> ${to}`);
}

function cmdNote(pos, flags) {
  const [id, ...rest] = pos;
  const text = rest.join(' ').trim();
  if (!id || !text) die('usage: note <ID> "<text>" --by <role>');
  if (typeof flags.by !== 'string') die('--by <role> required');
  const by = role(flags.by);
  guardWrite(flags);

  const t = findTicket(id);
  const { fm, body } = parseTicket(t.file);
  const ts = now();
  fm.updated = ts;
  fs.writeFileSync(t.file, renderTicket(fm, appendHistory(body, `${ts} — note by ${by}: ${text}`)));
  commit([t.file], `board: ${fm.id} note`, flags);
  console.log(`${fm.id}: note added`);
}

function cmdList(pos, flags) {
  if (pos[0] && !STATUSES.includes(pos[0])) die(`status must be one of ${STATUSES.join('|')}`);
  const rows = allTickets()
    .filter((t) => !pos[0] || t.status === pos[0])
    .map((t) => ({ ...parseTicket(t.file).fm, status: t.status, file: t.file }))
    .filter((r) => typeof flags.epic !== 'string' || r.epic === flags.epic)
    .filter((r) => typeof flags.type !== 'string' || r.type === flags.type.toUpperCase());
  if (!rows.length) return console.log('(no tickets)');
  for (const status of STATUSES) {
    const group = rows.filter((r) => r.status === status);
    if (!group.length) continue;
    console.log(`\n${status} (${group.length})`);
    for (const r of group) {
      const extra = (r.covers ? `  [covers ${r.covers}]` : '') + (r.depends_on ? `  [after ${r.depends_on}]` : '');
      console.log(`  ${r.id.padEnd(10)} ${(r.assignee || '-').padEnd(14)} ${r.title}${extra}`);
    }
  }
}

function cmdMode(pos) {
  const v = pos[0] || 'status';
  if (v === 'on') {
    fs.mkdirSync(path.dirname(FLAG), { recursive: true });
    fs.writeFileSync(FLAG, `enabled ${now()}\n`);
  } else if (v === 'off') {
    fs.rmSync(FLAG, { force: true });
  } else if (v !== 'status') {
    die('usage: mode <on|off|status>');
  }
  console.log(`slow-but-sure: ${fs.existsSync(FLAG) ? 'ON' : 'OFF'}`);
}

const { pos, flags } = parseArgs(process.argv.slice(2));
const cmd = pos.shift();
switch (cmd) {
  case 'init': cmdInit(); break;
  case 'new': cmdNew(pos, flags); break;
  case 'move': cmdMove(pos, flags); break;
  case 'note': cmdNote(pos, flags); break;
  case 'list': cmdList(pos, flags); break;
  case 'mode': cmdMode(pos); break;
  default: console.log(USAGE); process.exit(cmd ? 1 : 0);
}
