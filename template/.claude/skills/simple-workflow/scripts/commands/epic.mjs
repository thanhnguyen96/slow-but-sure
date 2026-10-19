// Epic folders: sw epic new <slug> | sw epic ls.
import fs from 'node:fs';
import path from 'node:path';
import { STATUSES } from '../lib/constants.mjs';
import { die, today, slugify } from '../lib/util.mjs';
import { EPICS, rel } from '../lib/repo.mjs';
import { allTickets, parseTicket } from '../lib/tickets.mjs';

const EPIC_FILES = {
  'brief.md': (name) => `# Brief: ${name}\n\n<!-- PM: goal, users, scope in/out, edge cases, acceptance criteria, what "done" means -->\n`,
  'design.md': (name) => `# Design: ${name}\n\n<!-- PM: every page with its elements and data-testid; links to mockups/ -->\n`,
  'plan.md': (name) => `# Plan: ${name}\n\n<!-- PM: system design (Backend / Frontend / Automation test) and the rough implementation plan -->\n`,
};

export function cmdEpic(pos) {
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
