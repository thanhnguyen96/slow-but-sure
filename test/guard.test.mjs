// sbs-guard.mjs: role limits per tool call, and the worker activity log and nudge.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, guard, bash, write } from './helpers.mjs';

let dir;
const SBS = 'node .claude/skills/slow-but-sure/scripts/sbs.mjs';
const allowed = (r) => { assert.equal(r.code, 0, r.err); assert.equal(r.json?.hookSpecificOutput?.permissionDecision, 'allow'); };
const blocked = (r, re) => { assert.equal(r.code, 2, r.out); if (re) assert.match(r.err, re); };

before(() => { dir = project('guard'); });

test('the PM (no agent_type) is not checked while the process is off', () => {
  const r = guard(dir, { tool_name: 'Bash', tool_input: { command: 'git push' } });
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
});

test('no role pushes, resets --hard or checks out the release branch', () => {
  for (const agent of ['lead-dev', 'dev', 'lead-qa', 'qa']) {
    blocked(guard(dir, bash(agent, 'git push origin dev')), /push/);
    blocked(guard(dir, bash(agent, 'git reset --hard HEAD~1')));
    blocked(guard(dir, bash(agent, 'git switch master')));
  }
});

test('each role runs only its own sbs commands', () => {
  allowed(guard(dir, bash('dev', `${SBS} merge FEAT-0001`)));
  blocked(guard(dir, bash('dev', `${SBS} approve FEAT-0001`)), /may not run `sbs approve`/);
  allowed(guard(dir, bash('lead-dev', `${SBS} approve FEAT-0001`)));
  blocked(guard(dir, bash('lead-dev', `${SBS} e2e`)));
  allowed(guard(dir, bash('lead-qa', `${SBS} e2e`)));
  for (const agent of ['dev', 'qa', 'lead-dev', 'lead-qa', 'reviewer']) blocked(guard(dir, bash(agent, `${SBS} watch`)), /watch/);
  blocked(guard(dir, bash('dev', `${SBS} merge FEAT-0001`, { run_in_background: true })), /background/);
});

test('only lead-qa runs e2e, and only through sbs', () => {
  for (const agent of ['dev', 'qa']) blocked(guard(dir, bash(agent, 'npx playwright test')), /e2e/);
  allowed(guard(dir, bash('qa', 'npx playwright test --list tests/e2e/a.spec.js')));
  blocked(guard(dir, bash('lead-qa', 'npx playwright test')), /sbs e2e/);
  blocked(guard(dir, bash('lead-dev', 'npx playwright test --list')), /e2e/);
});

test('file writes follow each role\'s paths', () => {
  blocked(guard(dir, write('dev', path.join(dir, 'tickets/todo/FEAT-0001-x.md'))));
  blocked(guard(dir, write('dev', path.join(dir, 'docs/rules/conventions.md'))));
  allowed(guard(dir, write('dev', path.join(dir, 'src/a.js'))));
  blocked(guard(dir, write('qa', path.join(dir, 'src/a.js'))));
  allowed(guard(dir, write('qa', path.join(dir, 'tests/e2e/a.spec.js'))));
  blocked(guard(dir, write('lead-dev', path.join(dir, 'tests/unit/a.test.js'))));
  blocked(guard(dir, write('reviewer', path.join(dir, 'src/a.js'))));
  blocked(guard(dir, bash('qa', 'echo x > src/a.js')));
});

test('workers may read node_modules; nothing is blocked by the activity log', () => {
  allowed(guard(dir, { agent_type: 'dev', agent_id: 'nm', tool_name: 'Read', tool_input: { file_path: path.join(dir, 'node_modules/x/index.js') } }));
  allowed(guard(dir, bash('dev', 'node node_modules/x/probe.js')));
});

test('activity log: header, one line per call, a nudge every workerNudgeEvery calls', () => {
  const id = 'wlog';
  const call = (i) => guard(dir, { agent_type: 'dev', agent_id: id, tool_name: 'Read', tool_input: { file_path: `src/f${i}.js` } });
  let nudge = null;
  for (let i = 1; i <= 41; i++) {
    const r = call(i);
    allowed(r);
    const ctx = r.json.hookSpecificOutput.additionalContext;
    if (ctx) { assert.equal(nudge, null, 'only one nudge in 41 calls'); nudge = { i, ctx }; }
  }
  assert.equal(nudge?.i, 40);
  assert.match(nudge.ctx, /40 tool calls/);
  const lines = fs.readFileSync(path.join(dir, '.claude/sbs-activity', `${id}.log`), 'utf8').trim().split('\n');
  assert.equal(lines.length, 42);
  assert.match(lines[0], /^start \S+ dev /);
  assert.match(lines[1], /^\d\d:\d\d:\d\d #1 Read src\/f1\.js$/);
  assert.match(lines[41], /#41 Read src\/f41\.js$/);
});

test('leads and the reviewer get no activity log', () => {
  guard(dir, bash('lead-dev', 'git status'));
  guard(dir, { agent_type: 'reviewer', agent_id: 'rev', tool_name: 'Read', tool_input: { file_path: 'src/a.js' } });
  const logs = fs.existsSync(path.join(dir, '.claude/sbs-activity')) ? fs.readdirSync(path.join(dir, '.claude/sbs-activity')) : [];
  assert.ok(!logs.some((f) => f.startsWith('lead-dev') || f.startsWith('rev')), logs.join(','));
});
