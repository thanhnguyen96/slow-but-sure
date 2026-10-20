// Test helpers: a fresh project in sandbox/ with slow-but-sure installed, and runners for sbs and the guard hook.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SANDBOX = path.join(REPO, 'sandbox');

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
}

export function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

// sandbox/<name>: git repo on `dev` with slow-but-sure installed (no grill-me/opendesign) and committed.
export function project(name) {
  const dir = path.join(SANDBOX, name);
  rm(dir);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'master');
  git(dir, 'config', 'user.email', 'test@sbs');
  git(dir, 'config', 'user.name', 'sbs test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  execFileSync(process.execPath, [path.join(REPO, 'install.mjs'), dir, '--no-deps'], { encoding: 'utf8', stdio: 'pipe' });
  setConfig(dir, { commands: { setup: '', unit: 'node -e "process.exit(0)"', build: '', lint: '', e2e: 'npx playwright test --reporter=line', app: '' } }, false);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'install sbs');
  git(dir, 'switch', '-q', '-c', 'dev');
  return dir;
}

// Merges `patch` into tickets/config.json; commits it unless `commit` is false.
export function setConfig(dir, patch, commit = true) {
  const file = path.join(dir, 'tickets', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...cfg, ...patch }, null, 2) + '\n');
  if (commit) {
    git(dir, 'add', 'tickets/config.json');
    git(dir, 'commit', '-q', '-m', 'config');
  }
}

// Runs sbs in `cwd` (the main checkout or a worktree). Returns { code, out, err }.
export function sbs(cwd, ...args) {
  const r = spawnSync(process.execPath, [path.join(cwd, '.claude/skills/slow-but-sure/scripts/sbs.mjs'), ...args], {
    cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, SBS_ROOT: '' },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// A worker's worktree on ticket/<id>, branched from dev.
export function worktree(dir, id) {
  const wt = path.join(dir, '.claude', 'worktrees', id);
  git(dir, 'worktree', 'add', '-q', '-b', `ticket/${id}`, wt, 'dev');
  git(wt, 'config', 'user.email', 'test@sbs');
  git(wt, 'config', 'user.name', 'sbs test');
  return wt;
}

export function commitFile(cwd, file, content, msg) {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', '--', file);
  git(cwd, 'commit', '-q', '-m', msg);
}

// Runs the guard hook as Claude Code would for one tool call. Returns { code, out, err, json }.
export function guard(dir, input) {
  const r = spawnSync(process.execPath, [path.join(dir, '.claude/hooks/sbs-guard.mjs')], {
    input: JSON.stringify({ cwd: dir, ...input }), encoding: 'utf8', windowsHide: true,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}

export const bash = (agent, command, extra = {}) => ({ agent_type: agent, agent_id: `${agent}-1`, tool_name: 'Bash', tool_input: { command, ...extra } });
export const write = (agent, file) => ({ agent_type: agent, agent_id: `${agent}-1`, tool_name: 'Write', tool_input: { file_path: file, content: 'x' } });
