// Git access, main-checkout paths, config, board lock and board commits.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULT_CONFIG, LOCK_WAIT_MS, LOCK_STALE_MS, DIRTY_WAIT_S } from './constants.mjs';
import { die, sleep, readJSON } from './util.mjs';

export function git(args, cwd = MAIN) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function tryGit(args, cwd = MAIN) {
  try { return git(args, cwd); } catch { return null; }
}

export function worktrees() {
  const out = tryGit(['worktree', 'list', '--porcelain'], process.cwd());
  if (!out) return [];
  const list = [];
  for (const block of out.split(/\n\s*\n/)) {
    const wt = {};
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) wt.path = path.resolve(line.slice(9));
      if (line.startsWith('branch ')) wt.branch = line.slice(7).replace(/^refs\/heads\//, '');
    }
    if (wt.path) list.push(wt);
  }
  return list;
}

// The board always lives in the main checkout, even when sbs runs inside a worker's worktree.
function findMain() {
  if (process.env.SBS_ROOT) return path.resolve(process.env.SBS_ROOT);
  const wts = worktrees();
  if (wts.length) return wts[0].path;
  let d = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(d, 'tickets', 'config.json'))) return d;
    const parent = path.dirname(d);
    if (parent === d) return process.cwd();
    d = parent;
  }
}

export const MAIN = findMain();
export const IN_GIT = tryGit(['rev-parse', '--is-inside-work-tree']) === 'true';
export const TICKETS = path.join(MAIN, 'tickets');
export const EPICS = path.join(MAIN, 'docs', 'epics');
export const COUNTERS = path.join(TICKETS, '.counters.json');
export const FLAG = path.join(MAIN, '.claude', 'slow-but-sure.on');
export const MODELS_FILE = path.join(MAIN, '.claude', 'slow-but-sure.models.json');
export const README_TEMPLATE = new URL('../../templates/tickets-README.md', import.meta.url);

export function rel(file) {
  return path.relative(MAIN, file).split(path.sep).join('/');
}

export function config() {
  const c = readJSON(path.join(TICKETS, 'config.json'), {});
  return { ...DEFAULT_CONFIG, ...c, commands: { ...DEFAULT_CONFIG.commands, ...(c.commands || {}) } };
}

let lockHeld = null;
process.on('exit', () => { if (lockHeld) fs.rmSync(lockHeld, { force: true }); });

// One writer at a time across the main checkout and every worktree.
export function lock() {
  if (!IN_GIT) return;
  const file = path.resolve(MAIN, git(['rev-parse', '--git-common-dir']), 'sbs.lock');
  const start = Date.now();
  let told = false;
  for (;;) {
    try {
      fs.writeFileSync(file, `${process.pid} ${new Date().toISOString()} ${process.argv.slice(2).join(' ')}\n`, { flag: 'wx' });
      lockHeld = file;
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0;
      try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { continue; }
      if (age > LOCK_STALE_MS) { fs.rmSync(file, { force: true }); continue; }
      if (Date.now() - start > LOCK_WAIT_MS) die(`board is locked by: ${fs.readFileSync(file, 'utf8').trim()} (${file})`);
      if (!told) { console.log(`waiting for board lock (${fs.readFileSync(file, 'utf8').trim()})`); told = true; }
      sleep(1000);
    }
  }
}

// Test runs in the main checkout rewrite their reports; those never block a merge, even when tracked.
const RUN_OUTPUT = /^(test-results|playwright-report|coverage)\//;
function dirtyFiles() {
  return git(['status', '--porcelain', '--untracked-files=no']).split('\n').filter((l) => l && !RUN_OUTPUT.test(l.replace(/^\s*\S+\s+/, ''))).join('\n');
}

export function guardMain(flags, { clean = false } = {}) {
  if (!IN_GIT || flags['no-commit']) return;
  const branch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  const want = config().integrationBranch;
  if (branch !== want) die(`the main checkout (${MAIN}) is on '${branch}', not '${want}'. Board changes and merges happen on '${want}'.`);
  if (fs.existsSync(path.resolve(MAIN, git(['rev-parse', '--git-dir']), 'MERGE_HEAD'))) die('a merge is already in progress in the main checkout');
  if (clean) {
    // A lead may be between an edit and its commit: wait a little before giving up.
    let dirty = dirtyFiles();
    for (let i = 0; dirty && i < DIRTY_WAIT_S / 5; i++) {
      if (!i) console.log('main checkout has uncommitted changes; waiting for the lead to commit them');
      sleep(5000);
      dirty = dirtyFiles();
    }
    if (dirty) die(`the main checkout has uncommitted changes; the lead must commit or stash them first:\n${dirty}`);
  }
}

export function commitFiles(files, msg, flags) {
  if (flags['no-commit'] || !IN_GIT) return;
  const paths = [...new Set(files)].map(rel);
  try {
    git(['add', '-A', '--', ...paths]);
    git(['commit', '-q', '-m', msg, '--', ...paths]);
  } catch (e) {
    die(`git commit failed: ${String(e.stderr || e.message).trim()}`);
  }
}

// Removes the worktree that has `branch` checked out but keeps the branch, so a new worker can switch to it.
export function freeBranch(branch) {
  if (!IN_GIT || !branch) return;
  for (const wt of worktrees().filter((w) => w.branch === branch && w.path !== MAIN)) {
    if (tryGit(['worktree', 'remove', wt.path]) === null) console.log(`  could not remove worktree ${wt.path} (uncommitted changes?); commit or discard them there before the next worker starts`);
    else console.log(`  removed worktree ${wt.path} (branch ${branch} kept for the next worker)`);
  }
  tryGit(['worktree', 'prune']);
}

// Removes the ticket's worktree and merged branch, plus empty worktree-agent-* branches. Best effort.
export function cleanupTicket(branch) {
  if (!IN_GIT || !branch) return;
  const dev = config().integrationBranch;
  for (const wt of worktrees().filter((w) => w.branch === branch && w.path !== MAIN)) {
    if (tryGit(['worktree', 'remove', wt.path]) === null) console.log(`  could not remove worktree ${wt.path} (dirty or in use); remove it later with \`sbs clean\``);
    else console.log(`  removed worktree ${wt.path}`);
  }
  tryGit(['worktree', 'prune']);
  const merged = (tryGit(['branch', '--merged', dev, '--format=%(refname:short)']) || '').split('\n').filter(Boolean);
  const checkedOut = new Set(worktrees().map((w) => w.branch));
  for (const b of merged) {
    if (checkedOut.has(b)) continue;
    if (b === branch || /^worktree-agent-/.test(b)) {
      if (tryGit(['branch', '-d', b]) !== null) console.log(`  deleted branch ${b}`);
    }
  }
}
