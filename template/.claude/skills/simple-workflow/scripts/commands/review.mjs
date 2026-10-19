// Lead commands after a merge: approve, reject, reopen, done.
import fs from 'node:fs';
import { LEVELS } from '../lib/constants.mjs';
import { die, now, cell } from '../lib/util.mjs';
import { lock, guardMain, commitFiles, cleanupTicket } from '../lib/repo.mjs';
import { level, leadOf, workerOf, by, findTicket, moveTicket, needStatus, epicLog, REVIEWS_HEADER } from '../lib/tickets.mjs';

export function cmdApprove(pos, flags) {
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

export function cmdReject(pos, flags) {
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

export function cmdReopen(pos, flags) {
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

export function cmdDone(pos, flags) {
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
