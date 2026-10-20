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

const locksHeld = new Set();
process.on('exit', () => { for (const f of locksHeld) fs.rmSync(f, { force: true }); });

// A lock left by a killed process (its pid is gone) is stale right away.
function holderAlive(file) {
  let pid = 0;
  try { pid = Number(fs.readFileSync(file, 'utf8').split(' ')[0]); } catch { return true; }
  if (!pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// One writer at a time across the main checkout and every worktree (`name` sbs: the board; e2e: one suite run at a time).
export function lock(name = 'sbs', what = 'board') {
  if (!IN_GIT) return;
  const file = path.resolve(MAIN, git(['rev-parse', '--git-common-dir']), `${name}.lock`);
  const start = Date.now();
  let told = false;
  for (;;) {
    try {
      fs.writeFileSync(file, `${process.pid} ${new Date().toISOString()} ${process.argv.slice(2).join(' ')}\n`, { flag: 'wx' });
      locksHeld.add(file);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0;
      try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { continue; }
      if (age > LOCK_STALE_MS || !holderAlive(file)) { fs.rmSync(file, { force: true }); continue; }
      if (Date.now() - start > LOCK_WAIT_MS) die(`${what} is locked by: ${fs.readFileSync(file, 'utf8').trim()} (${file})`);
      if (!told) { console.log(`waiting for ${what} lock (${fs.readFileSync(file, 'utf8').trim()})`); told = true; }
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
    if (dirty) console.log(`main checkout has uncommitted changes; waiting up to ${DIRTY_WAIT_S}s for the lead to commit them:\n${dirty}`);
    for (const until = Date.now() + DIRTY_WAIT_S * 1000; dirty && Date.now() < until;) {
      sleep(2000);
      dirty = dirtyFiles();
    }
    if (dirty) die(`the main checkout still has uncommitted changes:\n${dirty}\nThey are not yours: don't commit, stash or revert them. Report this list to your lead (a lead reports it to the PM).`);
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
  // One worktree listing: the removed ones are dropped from it instead of listing again.
  const checkedOut = new Set();
  for (const wt of worktrees()) {
    if (wt.branch === branch && wt.path !== MAIN) {
      if (tryGit(['worktree', 'remove', wt.path]) !== null) { console.log(`  removed worktree ${wt.path}`); continue; }
      console.log(`  could not remove worktree ${wt.path} (dirty or in use); remove it later with \`sbs clean\``);
    }
    checkedOut.add(wt.branch);
  }
  tryGit(['worktree', 'prune']);
  const merged = (tryGit(['branch', '--merged', dev, '--format=%(refname:short)']) || '').split('\n').filter(Boolean);
  for (const b of merged) {
    if (checkedOut.has(b)) continue;
    if (b === branch || /^worktree-agent-/.test(b)) {
      if (tryGit(['branch', '-d', b]) !== null) console.log(`  deleted branch ${b}`);
    }
  }
}
