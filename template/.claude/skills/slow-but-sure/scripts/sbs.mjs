#!/usr/bin/env node
// slow-but-sure (sbs): ticket board, epic folders and merge tool. Zero dependencies.
// Usage: node .claude/skills/slow-but-sure/scripts/sbs.mjs <command> ...   (no args = help)
//
// lib/constants.mjs   statuses, roles, default config and models
// lib/util.mjs        die, time, slug, JSON helpers
// lib/repo.mjs        git, main checkout paths, config, lock, board commits, worktree cleanup
// lib/tickets.mjs     ticket files and epic logs
// commands/board.mjs  init, new, start, note, mv, ls, show, clean
// commands/merge.mjs  merge
// commands/review.mjs approve, reject, reopen, done
// commands/epic.mjs   epic new | ls
// commands/setup.mjs  models, mode
import { STATUSES, ROLES, LEVELS } from './lib/constants.mjs';
import { cmdInit, cmdNew, cmdStart, cmdNote, cmdMv, cmdLs, cmdShow, cmdClean } from './commands/board.mjs';
import { cmdMerge } from './commands/merge.mjs';
import { cmdApprove, cmdReject, cmdReopen, cmdDone } from './commands/review.mjs';
import { cmdEpic } from './commands/epic.mjs';
import { cmdModels, cmdMode } from './commands/setup.mjs';

const SHORT_FLAGS = { e: 'epic', t: 'type', n: 'note', b: 'by', l: 'level', d: 'depends', c: 'covers' };

const USAGE = `sbs: slow-but-sure board        (sbs = node .claude/skills/slow-but-sure/scripts/sbs.mjs)

Tickets
  sbs new <feat|bug|ref|init|test> "<title>" -e <epic> [-d ID,ID] [-c ID,ID] [-l level] [-b role]
  sbs start <ID> [-l level]            todo -> in-progress, assignee dev (qa for TEST)
  sbs merge <ID> [--no-checks]         worker: merge ticket/<ID> into dev, run checks, -> ready-to-review
                                      exit 2 = conflict, exit 3 = checks failed (nothing merged)
  sbs approve <ID> ["note"]            lead: ready-to-review -> ready-to-test, cleans worktree + branch
  sbs reject <ID> "<findings>"         lead: ready-to-review -> in-progress (same level; frees the branch for a new worker)
  sbs reopen <ID> "<context summary>"  back to in-progress, level +1 (junior -> middle -> senior)
  sbs done <ID> [ID...]                lead-qa: ready-to-test -> done
  sbs note <ID> "<text>"
  sbs mv <ID> <status> [-n "note"]     manual move (PM override)
  sbs ls [status] [-e epic] [-t type]
  sbs show <ID>
  sbs clean                            remove worktrees/branches of approved tickets

Epics
  sbs epic new <slug>                  create docs/epics/<YYYYMMDD>-<slug>/
  sbs epic [ls]                        list epics with ticket counts

Setup
  sbs init | sbs models [--json] | sbs mode <on|off|status>

-b/--by defaults to the role that normally runs the command.
statuses: ${STATUSES.join(', ')}
roles: ${ROLES.join(', ')}   levels: ${LEVELS.join(', ')}`;

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

const COMMANDS = {
  init: cmdInit, new: cmdNew, start: cmdStart, merge: cmdMerge, approve: cmdApprove, reject: cmdReject,
  reopen: cmdReopen, done: cmdDone, note: cmdNote, mv: cmdMv, ls: cmdLs, list: cmdLs, show: cmdShow,
  clean: cmdClean, epic: cmdEpic, models: cmdModels, mode: cmdMode,
};

const { pos, flags } = parseArgs(process.argv.slice(2));
const cmd = pos.shift();
if (!COMMANDS[cmd]) {
  console.log(USAGE);
  process.exit(cmd && cmd !== 'help' ? 1 : 0);
}
COMMANDS[cmd](pos, flags);
