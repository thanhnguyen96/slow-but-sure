// Board commands: init, new, start, note, mv, ls, show, clean.
import fs from 'node:fs';
import path from 'node:path';
import { STATUSES, TYPES, DEFAULT_CONFIG } from '../lib/constants.mjs';
import { die, now, slugify, readJSON, writeJSON } from '../lib/util.mjs';
import { TICKETS, EPICS, COUNTERS, README_TEMPLATE, IN_GIT, tryGit, rel, lock, guardMain, commitFiles, cleanupTicket, freeBranch, worktrees } from '../lib/repo.mjs';
import {
  level, idList, leadOf, workerOf, by, parseTicket, renderTicket, appendHistory,
  allTickets, findTicket, moveTicket, needStatus, ticketTemplate,
} from '../lib/tickets.mjs';

export function cmdInit() {
  for (const status of STATUSES) {
    fs.mkdirSync(path.join(TICKETS, status), { recursive: true });
    const keep = path.join(TICKETS, status, '.gitkeep');
    if (!fs.existsSync(keep)) fs.writeFileSync(keep, '');
  }
  fs.mkdirSync(EPICS, { recursive: true });
  const cfg = path.join(TICKETS, 'config.json');
  if (!fs.existsSync(cfg)) {
    // Release branch: master, or main when only main exists.
    const has = (b) => IN_GIT && tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]) !== null;
    const releaseBranch = !has('master') && has('main') ? 'main' : DEFAULT_CONFIG.releaseBranch;
    writeJSON(cfg, { ...DEFAULT_CONFIG, releaseBranch });
  } else {
    // Config from the old slow-but-sure name: keep the user's commands, add the new keys.
    const c = readJSON(cfg, {});
    // The first devBlocked default blocked all of docs/, including product docs.
    const oldDevBlocked = JSON.stringify(c.devBlocked) === JSON.stringify(['tickets/**', 'docs/**']);
    // The default qaWritable before screenshots: add the screenshots folder.
    const oldQaWritable = JSON.stringify(c.qaWritable) === JSON.stringify(['tests/e2e/**', 'playwright.config.*', 'docs/epics/*/qa-plan.md', 'tickets/*/TEST-*.md']);
    if (c.testerWritable || !c.qaWritable || !c.leadDevBlocked || !c.mergeChecks || !c.devBlocked || oldDevBlocked || oldQaWritable || !('setup' in (c.commands || {}))) {
      delete c.testerWritable;
      if (oldDevBlocked) delete c.devBlocked;
      if (oldQaWritable) delete c.qaWritable;
      writeJSON(cfg, { ...DEFAULT_CONFIG, ...c, commands: { ...DEFAULT_CONFIG.commands, ...(c.commands || {}) } });
      console.log(`updated ${rel(cfg)} (qaWritable, leadDevBlocked, devBlocked, mergeChecks, commands.setup)`);
    }
  }
  if (!fs.existsSync(COUNTERS)) writeJSON(COUNTERS, {});
  // Generated file: always refreshed so it matches this version of the flow.
  if (fs.existsSync(README_TEMPLATE)) fs.copyFileSync(README_TEMPLATE, path.join(TICKETS, 'README.md'));
  console.log(`board ready: ${rel(TICKETS) || '.'} (${STATUSES.join(', ')}); epics in ${rel(EPICS)}/`);
}

export function cmdNew(pos, flags) {
  const type = (pos[0] || '').toUpperCase();
  const title = pos.slice(1).join(' ').trim();
  if (!TYPES.includes(type)) die(`type must be one of ${TYPES.map((t) => t.toLowerCase()).join('|')}`);
  if (!title) die('title required');
  if (type === 'TEST' && typeof flags.covers !== 'string') die('TEST tickets need -c <ID[,ID]> (the dev tickets they cover)');
  if (!fs.existsSync(TICKETS)) die('no tickets/ here; run `sbs init` first');
  const epic = typeof flags.epic === 'string' ? flags.epic : '';
  if (epic && !fs.existsSync(path.join(EPICS, epic))) die(`epic folder docs/epics/${epic}/ does not exist (see \`sbs epic\`)`);
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

export function cmdStart(pos, flags) {
  const t = findTicket(pos[0]);
  // A relaunch (the worker died or was stopped): its worktree still holds the branch, and a new worker
  // in its own worktree cannot switch to it or remove the old one.
  if (t.status === 'in-progress') {
    freeBranch(t.fm.branch);
    console.log(`${t.id}: already in-progress (level ${t.fm.level || 'junior'}); branch ${t.fm.branch} is free for a new worker: git switch ${t.fm.branch}`);
    return;
  }
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

export function cmdNote(pos, flags) {
  const t = findTicket(pos[0]);
  const text = pos.slice(1).join(' ').trim();
  if (!text) die(`usage: sbs note ${t.id} "<text>"`);
  const who = by(flags, leadOf(t.fm.type));
  lock();
  guardMain(flags);
  const ts = now();
  fs.writeFileSync(t.file, renderTicket({ ...t.fm, updated: ts }, appendHistory(t.body, `${ts} — note by ${who}: ${text}`)));
  commitFiles([t.file], `board: ${t.id} note`, flags);
  console.log(`${t.id}: note added`);
}

export function cmdMv(pos, flags) {
  const t = findTicket(pos[0]);
  const to = pos[1];
  if (!STATUSES.includes(to)) die(`usage: sbs mv <ID> <${STATUSES.join('|')}> [-n "note"]`);
  const who = by(flags, 'pm');
  const changes = typeof flags.level === 'string' ? { level: level(flags.level) } : {};
  lock();
  guardMain(flags);
  const note = typeof flags.note === 'string' ? `: ${flags.note}` : '';
  const files = moveTicket(t, to, `${t.status} -> ${to} by ${who} (manual)${note}`, changes);
  commitFiles(files, `board: ${t.id} ${t.status} -> ${to}`, flags);
  console.log(`${t.id}: ${t.status} -> ${to}`);
}

export function cmdLs(pos, flags) {
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

export function cmdShow(pos) {
  const t = findTicket(pos[0]);
  console.log(`# ${rel(t.file)}\n`);
  console.log(fs.readFileSync(t.file, 'utf8').replace(/\r\n/g, '\n').trimEnd());
}

export function cmdClean() {
  const approved = allTickets().filter((t) => t.status === 'ready-to-test' || t.status === 'done');
  for (const t of approved) cleanupTicket(parseTicket(t.file).fm.branch);
  cleanupTicket('');
  const left = worktrees().slice(1);
  console.log(left.length ? `worktrees still present:\n${left.map((w) => `  ${w.path} [${w.branch || 'detached'}]`).join('\n')}` : 'no linked worktrees left');
}
