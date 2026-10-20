// sbs board flow: init, epic, new, start, merge (ok, conflict, failed checks), approve, reject, reopen, done, clean.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, sbs, worktree, commitFile, setConfig, git } from './helpers.mjs';

let dir, epic;
const ok = (r) => { assert.equal(r.code, 0, r.out + r.err); return r.out; };
const statusOf = (id) => fs.readdirSync(path.join(dir, 'tickets')).find((s) => {
  try { return fs.readdirSync(path.join(dir, 'tickets', s)).some((f) => f.startsWith(`${id}-`)); } catch { return false; }
});

before(() => {
  dir = project('board');
  ok(sbs(dir, 'epic', 'new', 'demo'));
  epic = fs.readdirSync(path.join(dir, 'docs', 'epics'))[0];
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'epic');
});

test('init made the board and config', () => {
  for (const s of ['todo', 'in-progress', 'ready-to-review', 'ready-to-test', 'done']) assert.ok(fs.existsSync(path.join(dir, 'tickets', s)), s);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'tickets', 'config.json'), 'utf8'));
  assert.equal(cfg.integrationBranch, 'dev');
  assert.deepEqual(cfg.workerAlert, { calls: 60, minutes: 15, every: 40 });
});

test('new ticket has a Brief ACs line and starts in todo at junior', () => {
  ok(sbs(dir, 'new', 'feat', 'First feature', '-e', epic));
  assert.equal(statusOf('FEAT-0001'), 'todo');
  const show = ok(sbs(dir, 'show', 'FEAT-0001'));
  assert.match(show, /Brief ACs:/);
  assert.match(show, /level: junior/);
});

test('TEST ticket needs -c', () => {
  assert.notEqual(sbs(dir, 'new', 'test', 'Tests', '-e', epic).code, 0);
});

test('start, merge, approve: ticket reaches ready-to-test and its branch is gone', () => {
  ok(sbs(dir, 'start', 'FEAT-0001'));
  assert.equal(statusOf('FEAT-0001'), 'in-progress');
  const wt = worktree(dir, 'FEAT-0001');
  commitFile(wt, 'src/a.js', 'export const a = 1;\n', 'FEAT-0001: a');
  const out = ok(sbs(wt, 'merge', 'FEAT-0001'));
  assert.match(out, /merged/i);
  assert.equal(statusOf('FEAT-0001'), 'ready-to-review');
  assert.ok(fs.readFileSync(path.join(dir, 'docs', 'epics', epic, 'merges.md'), 'utf8').includes('FEAT-0001'));
  ok(sbs(dir, 'approve', 'FEAT-0001'));
  assert.equal(statusOf('FEAT-0001'), 'ready-to-test');
  assert.equal(git(dir, 'branch', '--list', 'ticket/FEAT-0001'), '');
  assert.ok(!fs.existsSync(wt));
});

test('merge conflict exits 2 and leaves dev unchanged', () => {
  ok(sbs(dir, 'new', 'feat', 'Conflicting', '-e', epic));
  ok(sbs(dir, 'start', 'FEAT-0002'));
  const wt = worktree(dir, 'FEAT-0002');
  commitFile(wt, 'src/a.js', 'export const a = 2;\n', 'FEAT-0002: a=2');
  commitFile(dir, 'src/a.js', 'export const a = 3;\n', 'dev: a=3');
  const head = git(dir, 'rev-parse', 'HEAD');
  const r = sbs(wt, 'merge', 'FEAT-0002');
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.err, /CONFLICT/);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(statusOf('FEAT-0002'), 'in-progress');
  // the worker resolves it in its worktree and merges again
  try { git(wt, 'merge', 'dev'); } catch {}
  commitFile(wt, 'src/a.js', 'export const a = 23;\n', 'FEAT-0002: resolve');
  ok(sbs(wt, 'merge', 'FEAT-0002'));
  assert.equal(statusOf('FEAT-0002'), 'ready-to-review');
});

test('failing checks exit 3 and merge nothing', () => {
  setConfig(dir, { commands: { setup: '', unit: 'node -e "process.exit(1)"', build: '', lint: '', e2e: '', app: '' } });
  ok(sbs(dir, 'new', 'bug', 'Broken', '-e', epic));
  ok(sbs(dir, 'start', 'BUG-0001'));
  const wt = worktree(dir, 'BUG-0001');
  commitFile(wt, 'src/b.js', 'x\n', 'BUG-0001: b');
  const head = git(dir, 'rev-parse', 'HEAD');
  const r = sbs(wt, 'merge', 'BUG-0001');
  assert.equal(r.code, 3, r.out + r.err);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(git(dir, 'status', '--porcelain', '--untracked-files=no'), '');
  setConfig(dir, { commands: { setup: '', unit: 'node -e "process.exit(0)"', build: '', lint: '', e2e: '', app: '' } });
  ok(sbs(wt, 'merge', 'BUG-0001'));
});

test('reject keeps the level and frees the branch; reopen raises the level', () => {
  ok(sbs(dir, 'reject', 'FEAT-0002', 'src/a.js:1 wrong value'));
  assert.equal(statusOf('FEAT-0002'), 'in-progress');
  assert.match(ok(sbs(dir, 'show', 'FEAT-0002')), /level: junior/);
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'worktrees', 'FEAT-0002')));
  assert.notEqual(git(dir, 'branch', '--list', 'ticket/FEAT-0002'), '');
  const out = ok(sbs(dir, 'reopen', 'FEAT-0002', 'rejected twice'));
  assert.match(out, /junior -> middle/);
});

test('start on an in-progress ticket frees its branch for a relaunch', () => {
  const wt = path.join(dir, '.claude', 'worktrees', 'FEAT-0002b');
  git(dir, 'worktree', 'add', '-q', wt, 'ticket/FEAT-0002');
  const out = ok(sbs(dir, 'start', 'FEAT-0002'));
  assert.match(out, /free for a new worker/);
  assert.ok(!fs.existsSync(wt));
});

test('done needs ready-to-test; clean leaves no linked worktrees', () => {
  assert.notEqual(sbs(dir, 'done', 'FEAT-0002').code, 0);
  ok(sbs(dir, 'done', 'FEAT-0001'));
  assert.equal(statusOf('FEAT-0001'), 'done');
  ok(sbs(dir, 'approve', 'BUG-0001'));
  for (const wt of fs.readdirSync(path.join(dir, '.claude', 'worktrees'))) git(dir, 'worktree', 'remove', '--force', path.join(dir, '.claude', 'worktrees', wt));
  assert.match(ok(sbs(dir, 'clean')), /no linked worktrees left/);
});

test('board commands refuse to run off dev', () => {
  git(dir, 'switch', '-q', '-c', 'other');
  const r = sbs(dir, 'new', 'feat', 'Nope', '-e', epic);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /not 'dev'/);
  git(dir, 'switch', '-q', 'dev');
});
