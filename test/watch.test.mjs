// sbs watch: ALERT lines for long-running workers, from the activity logs.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { project, worktree } from './helpers.mjs';

let dir, logs;

// A log as the guard hook writes it: header, then `calls` lines.
function writeLog(id, { calls, startedMinAgo = 0, cwd = dir, agent = 'dev' }) {
  const started = new Date(Date.now() - startedMinAgo * 60000).toISOString();
  const lines = [`start ${started} ${agent} ${cwd}`];
  for (let i = 1; i <= calls; i++) lines.push(`12:00:00 #${i} Bash step ${i}`);
  fs.writeFileSync(path.join(logs, `${id}.log`), lines.join('\n') + '\n');
}

// Runs `sbs watch` for one pass (it never exits on its own) and returns its output.
function watchOnce(...args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['.claude/skills/slow-but-sure/scripts/sbs.mjs', 'watch', ...args], { cwd: dir, windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    setTimeout(() => { p.kill(); resolve(out); }, 1500);
  });
}

before(() => {
  dir = project('watch');
  logs = path.join(dir, '.claude', 'sbs-activity');
  fs.mkdirSync(logs, { recursive: true });
});

test('quiet below the thresholds, no board lines', async () => {
  writeLog('a-short', { calls: 10 });
  assert.equal((await watchOnce()).trim(), '');
});

test('ALERT on calls, with role, branch, count, last line and log path', async () => {
  const wt = worktree(dir, 'FEAT-0009');
  writeLog('a-calls', { calls: 61, cwd: wt });
  const out = await watchOnce();
  assert.match(out, /^ALERT worker a-calls \(dev, ticket\/FEAT-0009\): 61 calls, 0 min\. Last: 12:00:00 #61 Bash step 61\. Log: \.claude\/sbs-activity\/a-calls\.log$/m);
  assert.doesNotMatch(out, /a-short/);
});

test('ALERT on minutes', async () => {
  writeLog('a-slow', { calls: 5, startedMinAgo: 20, agent: 'qa' });
  assert.match(await watchOnce(), /ALERT worker a-slow \(qa, .*\): 5 calls, 20 min/);
});

test('a log quiet for 5 minutes is a returned worker: no ALERT', async () => {
  writeLog('a-gone', { calls: 99 });
  const old = new Date(Date.now() - 6 * 60000);
  fs.utimesSync(path.join(logs, 'a-gone.log'), old, old);
  assert.doesNotMatch(await watchOnce(), /a-gone/);
});

test('flags override the config thresholds', async () => {
  for (const f of fs.readdirSync(logs)) fs.rmSync(path.join(logs, f));
  writeLog('a-flag', { calls: 3 });
  assert.match(await watchOnce('--calls', '3'), /ALERT worker a-flag/);
});
