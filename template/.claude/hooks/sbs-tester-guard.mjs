#!/usr/bin/env node
// PreToolUse hook (project settings): when the caller is a tester agent, block file writes
// outside `testerWritable` (tickets/config.json). Other agents and the main conversation pass.
// Exit 2 = block the tool call; stderr is shown to the agent.
import fs from 'node:fs';
import path from 'node:path';

const TESTER_AGENTS = ['tester-lead', 'tester'];
const DEFAULT_WRITABLE = ['tests/e2e/**', 'playwright.config.*', 'docs/specs/*/test-plan.md', 'tickets/*/TEST-*.md'];

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let input;
try { input = JSON.parse(raw); } catch { process.exit(0); }
if (!TESTER_AGENTS.includes(input.agent_type)) process.exit(0);

const toolInput = input.tool_input || {};
const target = toolInput.file_path || toolInput.notebook_path || toolInput.path;
if (!target) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
let writable = DEFAULT_WRITABLE;
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'tickets', 'config.json'), 'utf8'));
  if (Array.isArray(cfg.testerWritable)) writable = cfg.testerWritable;
} catch {}

// Glob to regex matched against the path suffix, so it works in any worktree location.
function globToRegex(glob) {
  const body = glob.split('/').map((seg) => (seg === '**' ? '\u0000'
    : seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))).join('/')
    .replace(/\/\u0000/g, '(?:/.*)?').replace(/\u0000\//g, '(?:.*/)?').replace(/\u0000/g, '.*');
  return new RegExp(`(^|/)${body}$`);
}

const file = path.resolve(input.cwd || process.cwd(), target).split(path.sep).join('/');
if (writable.some((g) => globToRegex(g).test(file))) process.exit(0);

process.stderr.write(
  `slow-but-sure: testers may not modify ${file}. Writable: ${writable.join(', ')}. ` +
  'If product code is wrong, report it as a Dev-caused failure instead of changing it.\n'
);
process.exit(2);
