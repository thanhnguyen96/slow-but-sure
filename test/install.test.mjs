// install.mjs: files, hooks, .gitignore, board; a second install keeps the user's files.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO, project } from './helpers.mjs';

let dir;
before(() => { dir = project('install'); });

test('copies agents, hooks and skills', () => {
  for (const f of ['agents/dev.md', 'agents/lead-dev.md', 'agents/lead-qa.md', 'agents/qa.md', 'agents/reviewer.md',
    'hooks/sbs-guard.mjs', 'hooks/sbs-reminder.mjs', 'skills/slow-but-sure/SKILL.md', 'skills/slow-but-sure/scripts/commands/watch.mjs']) {
    assert.ok(fs.existsSync(path.join(dir, '.claude', f)), f);
  }
});

test('registers both hooks; the guard covers Read, Glob and Grep for the activity log', () => {
  const s = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8'));
  const pre = s.hooks.PreToolUse.find((g) => g.hooks.some((h) => h.command.includes('sbs-guard.mjs')));
  assert.equal(pre.matcher, 'Edit|Write|NotebookEdit|Bash|PowerShell|Agent|Read|Glob|Grep');
  assert.ok(s.hooks.UserPromptSubmit.some((g) => g.hooks.some((h) => h.command.includes('sbs-reminder.mjs'))));
});

test('.gitignore covers worktrees and activity logs', () => {
  const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  for (const l of ['.claude/worktrees/', '.claude/sbs-activity/', '.claude/slow-but-sure.on']) assert.ok(gi.includes(l), l);
});

test('a second install skips existing files and does not duplicate hooks', () => {
  const agent = path.join(dir, '.claude/agents/dev.md');
  fs.writeFileSync(agent, 'custom');
  execFileSync(process.execPath, [path.join(REPO, 'install.mjs'), dir, '--no-deps'], { encoding: 'utf8', stdio: 'pipe' });
  assert.equal(fs.readFileSync(agent, 'utf8'), 'custom');
  const s = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8'));
  assert.equal(s.hooks.PreToolUse.filter((g) => g.hooks.some((h) => h.command.includes('sbs-guard.mjs'))).length, 1);
});
