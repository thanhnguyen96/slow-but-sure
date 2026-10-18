#!/usr/bin/env node
// slow-but-sure ticket board. Zero dependencies.
// Usage: node .claude/skills/slow-but-sure/scripts/board.mjs <init|new|move|note|list|mode> ...
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const STATUSES = ['todo', 'in-progress', 'ready-to-test', 'done'];
const TYPES = ['FEAT', 'BUG', 'REF', 'INIT', 'TEST'];
const ROLES = ['pm', 'dev-lead', 'dev', 'tester-lead', 'tester', 'user'];
const LEVELS = ['junior', 'middle', 'senior'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const AGENT_MODELS = ['haiku', 'sonnet', 'opus', 'fable', 'inherit'];
const FM_KEYS = ['id', 'type', 'title', 'epic', 'created', 'updated', 'status', 'assigner', 'assignee', 'level', 'branch', 'depends_on', 'covers'];
const DEFAULT_CONFIG = {
  integrationBranch: 'dev',
  releaseBranch: 'master',
  web: true,
  commands: { unit: '', build: '', lint: '', e2e: 'npx playwright test', app: '' },
  testerWritable: ['tests/e2e/**', 'playwright.config.*', 'docs/specs/*/test-plan.md', 'tickets/*/TEST-*.md'],
};
// Model + effort per role and per worker level. Users edit .claude/slow-but-sure.models.json.
const DEFAULT_MODELS = {
  pm: { model: 'opus' }, // effort: set it yourself in the terminal with /effort
  'dev-lead': { model: 'sonnet', effort: 'xhigh' },
  'tester-lead': { model: 'sonnet', effort: 'xhigh' },
  levels: {
    junior: { model: 'haiku', effort: 'max' },
    middle: { model: 'sonnet', effort: 'xhigh' },
    senior: { model: 'opus', effort: 'medium' },
  },
};
const MODEL_ROWS = [
  ['pm', (m) => m.pm, 'main conversation: triage, grilling, mockups, gates'],
  ['dev-lead', (m) => m['dev-lead'], 'plan, dev tickets, review, merge'],
  ['tester-lead', (m) => m['tester-lead'], 'TEST tickets, review, merge, regression'],
  ['junior', (m) => m.levels.junior, 'dev/tester workers, default level'],
  ['middle', (m) => m.levels.middle, 'workers on a ticket reopened once'],
  ['senior', (m) => m.levels.senior, 'workers on a ticket reopened 2+ times (cap)'],
];
const MODEL_NOTES = { haiku: 'fastest, cheapest', sonnet: 'balanced', opus: 'strongest reasoning', inherit: 'same as caller' };
const EFFORT_NOTES = { low: 'quick', medium: 'balanced', high: 'careful', xhigh: 'very careful', max: 'deepest, slowest' };

const USAGE = `usage:
  board init
  board new <${TYPES.join('|')}> "<title>" --by <role> [--epic <dir>] [--assignee <role>] [--level <${LEVELS.join('|')}>] [--depends ID,ID] [--covers ID,ID] [--no-commit]
  board move <ID> <${STATUSES.join('|')}> --by <role> [--assignee <role>] [--level <lvl>] [--note "..."] [--no-commit]
      (moving a ticket back to in-progress after it left it = reopen: --note required, level goes up one step)
  board note <ID> "<text>" --by <role> [--no-commit]
  board list [status] [--epic <dir>] [--type <TYPE>]
  board models [--json]          show (and create on first run) .claude/slow-but-sure.models.json
  board mode <on|off|status>
roles: ${ROLES.join(', ')}   levels: ${LEVELS.join(', ')}`;

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
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { flags[key] = true; continue; }
    // repeated flags accumulate: --depends A --depends B == --depends A,B
    flags[key] = typeof flags[key] === 'string' ? `${flags[key]},${next}` : next;
    i++;
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
const MODELS_FILE = path.join(ROOT, '.claude', 'slow-but-sure.models.json');
const LOCAL_SETTINGS = path.join(ROOT, '.claude', 'settings.local.json');
const README_TEMPLATE = new URL('../templates/tickets-README.md', import.meta.url);

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
  const readme = path.join(TICKETS, 'README.md');
  if (!fs.existsSync(readme) && fs.existsSync(README_TEMPLATE)) fs.copyFileSync(README_TEMPLATE, readme);
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
    level: typeof flags.level === 'string' ? level(flags.level) : 'junior',
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
  // Reopen = back to in-progress after having left it. Needs a context summary and raises the level.
  const reopen = to === 'in-progress' && t.status !== 'in-progress' && /-> in-progress/.test(body);
  if (reopen && typeof flags.note !== 'string') {
    die(`${fm.id} is being reopened: --note "<context summary: what failed, evidence, what was tried>" is required`);
  }
  const prevLevel = LEVELS.includes(fm.level) ? fm.level : 'junior';
  if (typeof flags.level === 'string') fm.level = level(flags.level);
  else if (reopen) fm.level = LEVELS[Math.min(LEVELS.indexOf(prevLevel) + 1, LEVELS.length - 1)];
  else fm.level = prevLevel;
  fm.status = to;
  fm.updated = ts;
  let line = `${ts} — ${t.status} -> ${to} by ${by}`;
  if (reopen) line += ` (reopened, level ${prevLevel} -> ${fm.level})`;
  else if (fm.level !== prevLevel) line += ` (level ${prevLevel} -> ${fm.level})`;
  if (typeof flags.assignee === 'string') {
    fm.assignee = role(flags.assignee);
    line += ` (assignee: ${fm.assignee})`;
  }
  if (typeof flags.note === 'string') line += `: ${flags.note}`;
  const dest = path.join(TICKETS, to, path.basename(t.file));
  fs.writeFileSync(t.file, renderTicket(fm, appendHistory(body, line)));
  if (dest !== t.file) fs.renameSync(t.file, dest);
  commit([t.file, dest], `board: ${fm.id} ${t.status} -> ${to}`, flags);
  console.log(`${fm.id}: ${t.status} -> ${to}${reopen ? ` (reopened, level ${prevLevel} -> ${fm.level})` : ''}  level: ${fm.level}`);
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
      const who = `${r.assignee || '-'}/${r.level || 'junior'}`;
      console.log(`  ${r.id.padEnd(10)} ${who.padEnd(18)} ${r.title}${extra}`);
    }
  }
}

// ---------- models ----------

function loadModels() {
  if (!fs.existsSync(MODELS_FILE)) {
    fs.mkdirSync(path.dirname(MODELS_FILE), { recursive: true });
    writeJSON(MODELS_FILE, DEFAULT_MODELS);
    console.log(`created ${path.relative(ROOT, MODELS_FILE)} (edit it to change models/effort)`);
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8')); } catch (e) { die(`cannot parse ${MODELS_FILE}: ${e.message}`); }
  const m = {
    ...DEFAULT_MODELS, ...raw,
    levels: { ...DEFAULT_MODELS.levels, ...(raw.levels || {}) },
  };
  for (const [name, get] of MODEL_ROWS) {
    const v = get(m) || {};
    // PM goes to settings (any model id); subagents go through the Agent tool (aliases only).
    const okModel = name === 'pm' ? typeof v.model === 'string' && v.model : AGENT_MODELS.includes(v.model);
    if (!okModel) die(`${name}.model '${v.model}' invalid in ${MODELS_FILE}. Use one of ${AGENT_MODELS.join(', ')}`);
    if (name !== 'pm' && !EFFORTS.includes(v.effort)) die(`${name}.effort '${v.effort}' invalid. Use one of ${EFFORTS.join(', ')}`);
  }
  return m;
}

function printModels(m) {
  console.log(`slow-but-sure models (${path.relative(ROOT, MODELS_FILE).split(path.sep).join('/')})`);
  console.log(`  ${'ROLE'.padEnd(12)} ${'MODEL'.padEnd(26)} ${'EFFORT'.padEnd(26)} USED FOR`);
  for (const [name, get, use] of MODEL_ROWS) {
    const v = get(m);
    const model = `${v.model}${MODEL_NOTES[v.model] ? ` (${MODEL_NOTES[v.model]})` : ''}`;
    const effort = name === 'pm' ? '(yours, via /effort)' : `${v.effort} (${EFFORT_NOTES[v.effort]})`;
    console.log(`  ${name.padEnd(12)} ${model.padEnd(26)} ${effort.padEnd(26)} ${use}`);
  }
  console.log('  Workers start at junior; each reopen of a ticket raises it one level, up to senior.');
}

// PM = the main conversation, so its model lives in .claude/settings.local.json while ON (effort is the user's own /effort).
// The value that was there before is kept in the flag file and restored on `mode off`.
function applyPM(m) {
  const flag = readJSON(FLAG, null);
  const settings = readJSON(LOCAL_SETTINGS, {});
  const prev = flag?.prev ?? { model: settings.model ?? null };
  if (m.pm.model === 'inherit') delete settings.model; else settings.model = m.pm.model;
  writeJSON(LOCAL_SETTINGS, settings);
  writeJSON(FLAG, { enabled: flag?.enabled ?? now(), prev });
}

function restorePM() {
  const flag = readJSON(FLAG, null);
  if (!flag?.prev) return;
  const settings = readJSON(LOCAL_SETTINGS, {});
  for (const k of Object.keys(flag.prev)) {
    if (flag.prev[k] === null) delete settings[k]; else settings[k] = flag.prev[k];
  }
  writeJSON(LOCAL_SETTINGS, settings);
  console.log('PM model restored in .claude/settings.local.json');
}

function cmdModels(flags) {
  const m = loadModels();
  if (flags.json) return console.log(JSON.stringify(m, null, 2));
  printModels(m);
  if (fs.existsSync(FLAG)) applyPM(m);
}

function cmdMode(pos) {
  const v = pos[0] || 'status';
  if (v === 'on') {
    fs.mkdirSync(path.dirname(FLAG), { recursive: true });
    const m = loadModels();
    applyPM(m);
    printModels(m);
  } else if (v === 'off') {
    restorePM();
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
  case 'models': cmdModels(flags); break;
  case 'mode': cmdMode(pos); break;
  default: console.log(USAGE); process.exit(cmd ? 1 : 0);
}
