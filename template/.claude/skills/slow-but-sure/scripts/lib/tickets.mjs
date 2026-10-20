// Ticket files (parse, render, find, move) and the epic log files.
import fs from 'node:fs';
import path from 'node:path';
import { STATUSES, TYPES, ROLES, LEVELS, FM_KEYS } from './constants.mjs';
import { die, now } from './util.mjs';
import { TICKETS, EPICS, rel } from './repo.mjs';

export function role(r) {
  if (!ROLES.includes(r)) die(`unknown role '${r}'. roles: ${ROLES.join(', ')}`);
  return r;
}

export function level(l) {
  if (!LEVELS.includes(l)) die(`unknown level '${l}'. levels: ${LEVELS.join(', ')}`);
  return l;
}

export function idList(v) {
  if (typeof v !== 'string') return '';
  const ids = v.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const bad = ids.filter((id) => !new RegExp(`^(${TYPES.join('|')})-\\d{4}$`).test(id));
  if (bad.length) die(`invalid ticket id(s): ${bad.join(', ')}. Use full ids like FEAT-0001.`);
  return ids.join(', ');
}

export const leadOf = (type) => (type === 'TEST' ? 'lead-qa' : 'lead-dev');
export const workerOf = (type) => (type === 'TEST' ? 'qa' : 'dev');

export function by(flags, fallback) {
  return typeof flags.by === 'string' ? role(flags.by) : fallback;
}

export function parseTicket(file) {
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

export function renderTicket(fm, body) {
  const keys = [...FM_KEYS, ...Object.keys(fm).filter((k) => !FM_KEYS.includes(k))];
  return `---\n${keys.map((k) => `${k}: ${fm[k] ?? ''}`.trimEnd()).join('\n')}\n---\n${body}`;
}

export function appendHistory(body, line) {
  return body.replace(/\s*$/, '\n') + `- ${line}\n`;
}

export function allTickets() {
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

export function findTicket(id) {
  if (!id) die('ticket id required');
  const t = allTickets().find((x) => x.id === id.toUpperCase());
  if (!t) die(`ticket ${id} not found in ${rel(TICKETS)}/`);
  return { ...t, ...parseTicket(t.file) };
}

// Writes the ticket to its new status folder and returns [old, new] paths for the commit.
export function moveTicket(t, to, line, fmChanges = {}) {
  const fm = { ...t.fm, ...fmChanges, status: to, updated: now() };
  const dest = path.join(TICKETS, to, path.basename(t.file));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(t.file, renderTicket(fm, appendHistory(t.body, `${fm.updated} — ${line}`)));
  if (dest !== t.file) fs.renameSync(t.file, dest);
  return [t.file, dest];
}

export function needStatus(t, ...allowed) {
  if (!allowed.includes(t.status)) die(`${t.id} is in ${t.status}; this command needs ${allowed.join(' or ')}`);
}

export function ticketTemplate(id, title, epic) {
  return `
# ${id}: ${title}

## Context
${epic ? `Epic: docs/epics/${epic}/ (brief.md, design.md, plan.md, dev-plan.md / qa-plan.md)\n` : ''}Brief ACs: <!-- acceptance criteria of brief.md this ticket implements, by their brief number: AC2, AC5 -->
<!-- why this ticket exists; which sections of the epic docs it implements -->

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

export function epicLog(epic, name, header) {
  const dir = epic ? path.join(EPICS, epic) : TICKETS;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, header);
  return file;
}

export const MERGES_HEADER = `# Merges

Written by \`sbs merge\`. One row per merge of a ticket branch into dev. Review a row with \`git show <merge>\` (or \`git diff <merge>^1 <merge>\`).

| Time | Ticket | Title | Branch | Branch head | Merge commit | By |
|---|---|---|---|---|---|---|
`;
export const REVIEWS_HEADER = `# Reviews

Written by \`sbs approve\` and \`sbs reject\`.

| Time | Ticket | Merge commit | Verdict | By | Note |
|---|---|---|---|---|---|
`;
