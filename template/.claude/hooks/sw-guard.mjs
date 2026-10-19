#!/usr/bin/env node
// PreToolUse hook (project settings): limits where simple-workflow agents may write with Edit/Write.
//   lead-qa, qa: only inside `qaWritable` (tickets/config.json); never product code.
//   lead-dev:    never inside `leadDevBlocked`; tests belong to dev and qa workers.
// Other agents and the main conversation pass. Exit 2 = block the tool call; stderr is shown to the agent.
import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  qaWritable: ['tests/e2e/**', 'playwright.config.*', 'docs/epics/*/qa-plan.md', 'tickets/*/TEST-*.md'],
  leadDevBlocked: ['tests/**', '**/*.test.*', '**/*.spec.*', 'playwright.config.*'],
};

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let input;
try { input = JSON.parse(raw); } catch { process.exit(0); }
const agent = input.agent_type;
if (!['lead-qa', 'qa', 'lead-dev'].includes(agent)) process.exit(0);

const toolInput = input.tool_input || {};
const target = toolInput.file_path || toolInput.notebook_path || toolInput.path;
if (!target) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(root, 'tickets', 'config.json'), 'utf8')); } catch {}
const list = (key) => (Array.isArray(cfg[key]) ? cfg[key] : DEFAULTS[key]);

// Glob to regex matched against the path suffix, so it works in any worktree location.
function globToRegex(glob) {
  const body = glob.split('/').map((seg) => (seg === '**' ? '\u0000'
    : seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))).join('/')
    .replace(/\/\u0000/g, '(?:/.*)?').replace(/\u0000\//g, '(?:.*/)?').replace(/\u0000/g, '.*');
  return new RegExp(`(^|/)${body}$`);
}
const matches = (file, globs) => globs.some((g) => globToRegex(g).test(file));

const file = path.resolve(input.cwd || process.cwd(), target).split(path.sep).join('/');

if (agent === 'lead-dev') {
  const blocked = list('leadDevBlocked');
  if (!matches(file, blocked)) process.exit(0);
  process.stderr.write(
    `simple-workflow: lead-dev may not modify tests (${file}). Blocked: ${blocked.join(', ')}. ` +
    'Unit tests are written by dev workers, e2e tests by qa. If a test looks wrong, report it to the PM.\n'
  );
  process.exit(2);
}

const writable = list('qaWritable');
if (matches(file, writable)) process.exit(0);
process.stderr.write(
  `simple-workflow: ${agent} may not modify ${file}. Writable: ${writable.join(', ')}. ` +
  'If product code is wrong, report it to the PM as a dev-caused failure instead of changing it.\n'
);
process.exit(2);
