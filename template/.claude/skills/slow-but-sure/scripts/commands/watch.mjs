// watch: the PM's Monitor loop. Prints an ALERT when a dev/qa worker runs long (tool calls or minutes, from the activity logs the guard hook writes in .claude/sbs-activity/).
// It never exits; the PM runs it under Monitor and stops it when the leads have reported.
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from '../lib/util.mjs';
import { MAIN, config, tryGit } from '../lib/repo.mjs';

const ACTIVITY = path.join(MAIN, '.claude', 'sbs-activity');
const IDLE_MS = 5 * 60 * 1000; // a log quiet this long belongs to a worker that has returned

// Header line `start <ISO time> <agent> <cwd>`, then one line per tool call.
function workers() {
  let files = [];
  try { files = fs.readdirSync(ACTIVITY).filter((f) => f.endsWith('.log')); } catch {}
  return files.map((f) => {
    const file = path.join(ACTIVITY, f);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const [, started, agent, ...cwd] = (lines[0] || '').split(' ');
    return { id: f.slice(0, -4), file, agent, cwd: cwd.join(' '), started: Date.parse(started), calls: lines.length - 1, last: lines.at(-1), mtime: fs.statSync(file).mtimeMs };
  });
}

export function cmdWatch(pos, flags) {
  const { workerAlert } = config();
  const calls = Number(flags.calls) || workerAlert.calls;
  const minutes = Number(flags.minutes) || workerAlert.minutes;
  const every = Number(flags.every) || workerAlert.every;
  const alerted = new Map(); // agent id -> calls at the last alert
  for (;;) {
    const t = Date.now();
    for (const w of workers()) {
      if (t - w.mtime > IDLE_MS) continue;
      const mins = Math.round((t - w.started) / 60000);
      const at = alerted.get(w.id);
      const due = at === undefined ? w.calls >= calls || mins >= minutes : w.calls >= at + every;
      if (!due) continue;
      alerted.set(w.id, w.calls);
      const branch = (w.cwd && tryGit(['branch', '--show-current'], w.cwd)) || '?';
      console.log(`ALERT worker ${w.id} (${w.agent}, ${branch}): ${w.calls} calls, ${mins} min. Last: ${w.last.slice(0, 140)}. Log: ${path.relative(MAIN, w.file).split(path.sep).join('/')}`);
    }
    sleep(15000);
  }
}
