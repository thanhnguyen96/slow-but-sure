#!/usr/bin/env node
// UserPromptSubmit hook: while slow-but-sure is ON, remind the main conversation it is the PM.
// OFF (no flag file) prints nothing, so it costs no tokens.
import fs from 'node:fs';
import path from 'node:path';

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
if (!fs.existsSync(path.join(root, '.claude', 'slow-but-sure.on'))) process.exit(0);

process.stdout.write(
  '[slow-but-sure ON] You are the PM. Follow .claude/skills/slow-but-sure/SKILL.md (Read it if it is not in context). ' +
  'Triage first: ticket only for FEAT/BUG/large REF/INIT, otherwise handle directly and say "No ticket: <reason>". ' +
  'Never write product code or e2e tests yourself inside the ticket process; delegate to senior-dev / senior-tester.\n'
);
