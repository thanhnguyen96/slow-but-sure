#!/usr/bin/env node
// PreToolUse hook (project settings, matcher Edit|Write|NotebookEdit|Bash|PowerShell|Agent): role limits for slow-but-sure agents.
// Only subagents carry `agent_type`; the main conversation (PM) and other agents always pass.
//
// File writes (Edit/Write, and shell redirects, rm, mv, cp, touch, mkdir, tee, sed -i):
//   lead-qa, qa:  only inside `qaWritable` (tickets/config.json); never product code.
//   lead-dev:     never inside `leadDevBlocked`; tests belong to dev and qa workers.
//   dev:          never inside `devBlocked` (tickets/, docs/epics/, docs/conventions.md); the board changes only through `sbs`.
//   reviewer:     nothing.
// Bash:
//   every role:   no git push, reset --hard, branch -D, --no-verify, checkout of the release branch.
//   sbs:           each role only runs its own sbs commands (init, mv, mode, epic new are the PM's).
//   lead-dev:     no Playwright / e2e command.
//   e2e (`sbs e2e`, `sbs shot`): lead-qa only; workers and lead-dev never run it.
//   workers, leads: no app server or Playwright test run outside `sbs app` / `sbs e2e` / `sbs shot` (they start, wait and stop it);
//                 `sbs` never in the background (it returns on its own; a background run invites polling).
//   reviewer:     read-only command allowlist.
// A best-effort check against mistakes, not a sandbox. Exit 2 = block; stderr is shown to the agent.
//
// Every call that passes is allowed outright (permissionDecision "allow"), for the roles and, while the process is
// on, for the PM: auto mode's classifier otherwise blocks normal work (a worker's `sbs merge` writes the main
// checkout, compound commands, `cd` into a worktree) and agents cannot add allow rules themselves. The limits are
// each agent's tools and the rules here.
import fs from 'node:fs';
import path from 'node:path';

const ROLES = ['lead-dev', 'dev', 'lead-qa', 'qa', 'reviewer'];
const DEFAULTS = {
  qaWritable: ['tests/e2e/**', 'playwright.config.*', 'docs/epics/*/qa-plan.md', 'docs/epics/*/screenshots/**', 'tickets/*/TEST-*.md'],
  leadDevBlocked: ['tests/**', '**/*.test.*', '**/*.spec.*', 'playwright.config.*'],
  devBlocked: ['tickets/**', 'docs/epics/**', 'docs/conventions.md'],
};
const SBS_ALLOWED = {
  dev: ['merge', 'app', 'show', 'ls', 'list', 'epic', 'models', 'help', ''],
  qa: ['merge', 'app', 'show', 'ls', 'list', 'epic', 'models', 'help', ''],
  reviewer: ['show', 'ls', 'list', 'epic', 'models', 'help', ''],
  'lead-dev': ['new', 'start', 'approve', 'reject', 'reopen', 'note', 'app', 'show', 'ls', 'list', 'clean', 'epic', 'models', 'help', ''],
  'lead-qa': ['new', 'start', 'approve', 'reject', 'reopen', 'done', 'note', 'e2e', 'app', 'shot', 'show', 'ls', 'list', 'clean', 'epic', 'models', 'help', ''],
};
const REVIEWER_CMDS = ['cd', 'pwd', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'diff', 'echo', 'printf',
  'sort', 'uniq', 'cut', 'tr', 'awk', 'sed', 'git', 'node', 'npm', 'npx', 'true', 'test', '['];
const REVIEWER_GIT = ['diff', 'show', 'log', 'status', 'blame', 'grep', 'rev-parse', 'ls-files', 'cat-file', 'merge-base', 'rev-list', 'describe', 'shortlog', 'branch'];

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let input;
try { input = JSON.parse(raw); } catch { process.exit(0); }
const agent = input.agent_type;
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();

function allow() {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'slow-but-sure role check passed' } }));
  process.exit(0);
}

if (!ROLES.includes(agent)) {
  // The PM (main conversation, no agent_type), only while the process is on; other agents keep the normal checks.
  if (!agent && fs.existsSync(path.join(root, '.claude', 'slow-but-sure.on'))) allow();
  process.exit(0);
}

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(root, 'tickets', 'config.json'), 'utf8')); } catch {}
const list = (key) => (Array.isArray(cfg[key]) ? cfg[key] : DEFAULTS[key]);
const release = cfg.releaseBranch || 'master';
const commands = cfg.commands || {};
const toolInput = input.tool_input || {};

function block(msg) {
  process.stderr.write(`slow-but-sure: ${agent} ${msg}\n`);
  process.exit(2);
}

// Glob to regex, matched against the path relative to the repo or worktree root.
function globToRegex(glob) {
  const body = glob.split('/').map((seg) => (seg === '**' ? '\u0000'
    : seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))).join('/')
    .replace(/\/\u0000/g, '(?:/.*)?').replace(/\u0000\//g, '(?:.*/)?').replace(/\u0000/g, '.*');
  return new RegExp(`^${body}$`, 'i');
}
// Git Bash paths (/c/Users/...) to Windows paths, so path.resolve keeps the drive.
const fromBash = (p) => (process.platform === 'win32' ? p.replace(/^\/([a-z])(?=\/|$)/i, '$1:') : p);
// Path relative to the nearest repo or worktree root (a folder with .git); null outside any repo.
function repoRel(abs) {
  for (let d = path.dirname(abs); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return path.relative(d, abs).split(path.sep).join('/');
    if (path.dirname(d) === d) return null;
  }
}
const matches = (file, globs) => { const r = repoRel(file); return r !== null && globs.some((g) => globToRegex(g).test(r)); };

// Returns a reason string if the role may not write `file` (absolute path). Files outside any repo pass.
function writeDenied(file) {
  if (repoRel(file) === null) return null;
  if (agent === 'reviewer') return 'is read-only';
  if (agent === 'lead-dev' && matches(file, list('leadDevBlocked'))) {
    return `may not modify tests (${file}). Blocked: ${list('leadDevBlocked').join(', ')}. Unit tests are written by dev workers, e2e tests by qa. If a test looks wrong, report it to the PM.`;
  }
  if (agent === 'dev' && matches(file, list('devBlocked'))) {
    return `may not modify ${file}. Blocked: ${list('devBlocked').join(', ')}. The board changes only through \`sbs\`; epic docs and conventions belong to the PM and leads. Report the problem instead.`;
  }
  if ((agent === 'qa' || agent === 'lead-qa') && !matches(file, list('qaWritable'))) {
    return `may not modify ${file}. Writable: ${list('qaWritable').join(', ')}. If product code is wrong, report it to the PM as a dev-caused failure instead of changing it.`;
  }
  return null;
}

if (input.tool_name === 'PowerShell') block('may not use PowerShell; use Bash so the role check can see the command.');
if (input.tool_name !== 'Bash') {
  const target = toolInput.file_path || toolInput.notebook_path || toolInput.path;
  if (!target) allow();
  const why = writeDenied(path.resolve(fromBash(input.cwd || process.cwd()), fromBash(target)));
  if (why) block(why);
  allow();
}

// ---------- Bash ----------

// Splits a command line into segments (on ; && || | & newlines) of unquoted words; $(...) and backticks become segments too.
function parse(cmd) {
  const segs = [];
  let words = [], word = '', quoted = false, q = null, heredocs = [];
  const endWord = () => { if (word || quoted) words.push(word); word = ''; quoted = false; };
  const endSeg = () => { endWord(); if (words.length) segs.push(words); words = []; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < cmd.length) word += cmd[++i];
      else word += c;
      continue;
    }
    if (c === '\'' || c === '"') { q = c; quoted = true; continue; }
    if (c === '\\' && i + 1 < cmd.length) { word += cmd[++i]; continue; }
    if (c === '$' && cmd[i + 1] === '(' || c === '`') {
      const close = c === '`' ? '`' : ')';
      const start = i + (c === '`' ? 1 : 2);
      let depth = 1, j = start;
      for (; j < cmd.length; j++) {
        if (close === ')' && cmd[j] === '(') depth++;
        if (cmd[j] === close && --depth === 0) break;
      }
      segs.push(...parse(cmd.slice(start, j)));
      word += '__SUBST__';
      i = j;
      continue;
    }
    if (c === '\n' && heredocs.length) {
      // heredoc bodies are data (a script, a file's content), not commands: skip to each closing delimiter line
      endSeg();
      for (const end of heredocs) {
        for (;;) {
          const eol = cmd.indexOf('\n', i + 1);
          const lineText = cmd.slice(i + 1, eol === -1 ? cmd.length : eol);
          i = eol === -1 ? cmd.length : eol;
          if (lineText.replace(/^\t+/, '').replace(/\r$/, '') === end || eol === -1) break;
        }
      }
      heredocs = [];
      continue;
    }
    if (c === ';' || c === '\n' || c === '|' || c === '&' && cmd[i + 1] !== '>' && cmd[i - 1] !== '>') {
      if ((c === '|' || c === '&') && cmd[i + 1] === c) i++;
      endSeg();
      continue;
    }
    if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
      endWord();
      const m = cmd.slice(i + 2).match(/^-?\s*(?:'([^']*)'|"([^"]*)"|\\?([^\s;|&<>()]+))/);
      if (m) {
        heredocs.push(m[1] ?? m[2] ?? m[3]);
        i += 1 + m[0].length;
        continue;
      }
    }
    if (c === '>' || c === '<') {
      // A file descriptor right before the operator belongs to it: `2>&1`, `2>> log`.
      let op = c === '>' && /^\d+$/.test(word) ? word + c : c;
      if (op !== c) word = '';
      endWord();
      while (cmd[i + 1] === '>' || cmd[i + 1] === '&' || c === '<' && cmd[i + 1] === '<') op += cmd[++i];
      words.push(op);
      continue;
    }
    if (/\s/.test(c)) { endWord(); continue; }
    word += c;
  }
  endSeg();
  return segs;
}

let cwd = fromBash(input.cwd || process.cwd());

function checkWrite(target) {
  if (!target || /^&\d?$/.test(target) || target === '/dev/null' || /^nul$/i.test(target) || target === '__SUBST__') return;
  // `$TEMP/x`, `${TMPDIR}/x`: expand variables the hook can see, so a temp file isn't taken for a repo path.
  const expanded = target.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, v) => process.env[v] ?? m);
  const why = writeDenied(path.resolve(cwd, fromBash(expanded)));
  if (why) block(`${why} (shell write: ${target})`);
}

const args = (ws) => ws.filter((w) => !w.startsWith('-'));

for (let words of parse(String(toolInput.command || ''))) {
  // redirects: `> file`, `2>> file`, `&> file`
  const plain = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^\d*>{1,2}&?$|^&>{1,2}$/.test(w)) {
      if (!w.endsWith('&')) checkWrite(words[i + 1]);
      i++;
    } else if (/^<{1,3}$/.test(w)) i++;
    else plain.push(w);
  }
  words = plain;
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  if (!words.length) continue;
  let [cmd, ...rest] = words;
  if (['sudo', 'command', 'exec', 'time', 'xargs', 'env'].includes(cmd) && rest.length) [cmd, ...rest] = rest;
  const base = path.basename(cmd).replace(/\.exe$/i, '');
  const line = words.join(' ');

  if (['bash', 'sh', 'zsh', 'pwsh', 'powershell', 'cmd', 'eval'].includes(base)) {
    block(`may not start another shell (${base}); run the command directly so the role check can see it.`);
  }

  // git rules for every role
  if (base === 'git') {
    const sub = rest.find((w) => !w.startsWith('-') && !/^[a-z.]+=/.test(w) && rest[rest.indexOf(w) - 1] !== '-C' && rest[rest.indexOf(w) - 1] !== '-c');
    if (sub === 'push') block('may not push. Only the user pushes.');
    if (sub === 'reset' && rest.includes('--hard')) block('may not run git reset --hard. Ask the PM.');
    if (sub === 'branch' && rest.some((w) => w === '-D' || w === '--force' || w === '-f')) block('may not force-delete or force-move branches.');
    if (rest.includes('--no-verify') || rest.includes('-n') && sub === 'commit') block('may not skip git hooks (--no-verify).');
    if ((sub === 'checkout' || sub === 'switch') && rest.includes(release)) block(`may not check out ${release}; merges into ${release} are the PM's, after regression and user approval.`);
    if (sub === 'merge' && rest.includes(release) && agent !== 'dev' && agent !== 'qa') block(`may not merge ${release}.`);
    if (agent === 'reviewer' && !REVIEWER_GIT.includes(sub)) block(`is read-only; git ${sub} is not allowed. Allowed: git ${REVIEWER_GIT.join(', ')}.`);
    if (agent === 'reviewer' && sub === 'branch' && args(rest).length > 1) block('is read-only; only lists branches.');
    if ((sub === 'checkout' || sub === 'restore') && rest.includes('--')) for (const f of rest.slice(rest.indexOf('--') + 1)) checkWrite(f);
  }

  // sbs: each role only its own commands
  const swAt = rest.findIndex((w) => /(^|[\\/])sbs\.mjs$/.test(w));
  if (base === 'node' && swAt !== -1) {
    const swSub = rest[swAt + 1] && !rest[swAt + 1].startsWith('-') ? rest[swAt + 1] : '';
    if (!SBS_ALLOWED[agent].includes(swSub)) block(`may not run \`sbs ${swSub}\`. Allowed for ${agent}: ${SBS_ALLOWED[agent].filter(Boolean).join(', ')}. Ask your lead or the PM.`);
    if (swSub === 'epic' && rest[swAt + 2] === 'new') block('may not create epics; the PM does.');
    if (toolInput.run_in_background) block(`may not run \`sbs ${swSub}\` in the background. Run it in the foreground: it returns on its own (sbs e2e stops within 10 minutes).`);
  }

  // servers and Playwright test runs go through sbs app / sbs e2e
  if (agent !== 'reviewer') {
    const appCmd = commands.app && line.includes(commands.app);
    const npmServe = (base === 'npm' || base === 'pnpm' || base === 'yarn') && /^(start|(run )?(start|dev|serve|preview))\b/.test(rest.join(' '));
    const devServer = ['vite', 'next', 'nodemon', 'http-server', 'serve', 'live-server'].includes(base);
    const script = base === 'node' && rest.find((w) => !w.startsWith('-'));
    const nodeServer = script && /(^|[\\/])(server|app|main)\.[cm]?[jt]s$/i.test(script) && repoRel(path.resolve(cwd, fromBash(script))) !== null;
    if (appCmd || npmServe || devServer || nodeServer) block('may not start the app directly (it blocks the shell or is left running). Use `sbs app start` (background, recorded pid) and `sbs app stop`; for tests, `sbs e2e` starts and stops it itself.');
    // `playwright test` (any launcher: npx, pnpm exec, node_modules/.bin), not `--list`, which only lists the tests
    const pwAt = words.findIndex((w) => /(^|[\\/])playwright(\.cmd)?$/i.test(w));
    const pwTest = (pwAt !== -1 && words[pwAt + 1] === 'test' || commands.e2e && line.includes(commands.e2e)) && !words.includes('--list');
    if (pwTest && agent !== 'lead-dev') block(agent === 'lead-qa'
      ? 'may not run Playwright tests directly. Use `sbs e2e` (whole suite) or `sbs e2e <spec file> -g "name"` (a subset); it starts the app if needed, runs the tests and always stops the app. `npx playwright test --list` is allowed. Screenshots: `sbs shot`.'
      : 'may not run e2e tests; only lead-qa runs them, in regression mode. `npx playwright test --list` is allowed.');
  }

  // e2e belongs to lead-qa and qa
  if (agent === 'lead-dev' && (/\bplaywright\b/.test(line) || commands.e2e && line.includes(commands.e2e))) {
    block('may not run e2e tests (Playwright); that is lead-qa\'s job. Ask the PM to have lead-qa run them.');
  }

  // file-changing commands
  if (['rm', 'rmdir', 'touch', 'mkdir', 'tee', 'unlink', 'truncate'].includes(base)) for (const f of args(rest)) checkWrite(f);
  if (['mv', 'cp', 'ln', 'install'].includes(base)) for (const f of (base === 'mv' ? args(rest) : args(rest).slice(-1))) checkWrite(f);
  if (base === 'sed' && rest.some((w) => /^-[a-zA-Z]*i/.test(w) || w.startsWith('--in-place'))) for (const f of args(rest).slice(1)) checkWrite(f);
  if (base === 'cd') {
    const to = rest[0];
    if (to && to !== '-') cwd = path.resolve(cwd, fromBash(to.replace(/^~(?=$|\/)/, process.env.HOME || '~')));
  }

  // reviewer: read-only allowlist
  if (agent === 'reviewer') {
    if (!REVIEWER_CMDS.includes(base)) block(`is read-only; \`${base}\` is not allowed. Use git diff/show/log, sbs show/ls, cat, grep, ls, node -e, or the unit test command.`);
    if (base === 'find' && rest.some((w) => /^-(delete|exec|execdir|ok|fprint)/.test(w))) block('is read-only; find -delete/-exec is not allowed.');
    if ((base === 'npm' || base === 'npx') && !(commands.unit && line.startsWith(commands.unit)) && !/^npm (test|t|run test)\b/.test(line)) {
      block(`is read-only; only the unit command (${commands.unit || 'npm test'}) may run through npm/npx.`);
    }
  }
}
allow();
