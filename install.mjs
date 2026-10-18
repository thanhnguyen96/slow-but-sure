#!/usr/bin/env node
// Install slow-but-sure into a target project, plus its prerequisites:
//   - grill-me + grilling skills (mattpocock/skills, pinned commit) into <target>/.claude/skills/
//   - opendesign Claude Code plugin (manalkaff/opendesign), user scope, via the `claude` CLI
// Usage: node install.mjs <target-project-dir> [--force] [--no-deps]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(HERE, 'template');
const REMINDER_CMD = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/sbs-reminder.mjs"';
// Tester guard lives in project settings (not agent frontmatter): frontmatter hooks need the
// workspace-trust dialog and never run in -p sessions. The script itself filters on agent_type.
const GUARD_CMD = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/sbs-tester-guard.mjs"';
const GITIGNORE_LINES = ['.claude/slow-but-sure.on', '.claude/settings.local.json', '.claude/worktrees/', 'test-results/', 'playwright-report/', 'opendesign/'];

// Agent files from older versions (roles were renamed to dev-lead/dev/tester-lead/tester).
const LEGACY_AGENTS = ['senior-dev', 'junior-dev', 'senior-tester', 'junior-tester'];

const GRILL_REPO = 'mattpocock/skills';
const GRILL_SHA = '49dd158d1076134a641b33efb035946536778336';
const GRILL_SKILLS = ['grill-me', 'grilling'];
const OPENDESIGN_MARKETPLACE = 'manalkaff/opendesign';
const OPENDESIGN_PLUGIN = 'opendesign@opendesign';

const args = process.argv.slice(2);
const force = args.includes('--force');
const noDeps = args.includes('--no-deps');
const targetArg = args.find((a) => !a.startsWith('--'));
if (!targetArg) {
  console.error('usage: node install.mjs <target-project-dir> [--force] [--no-deps]');
  process.exit(1);
}
const TARGET = path.resolve(targetArg);
if (!fs.existsSync(TARGET)) {
  console.error(`target does not exist: ${TARGET}`);
  process.exit(1);
}

function copyTree(src, dst) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyTree(s, d);
    } else if (fs.existsSync(d) && !force) {
      console.log(`  skip (exists, use --force): ${path.relative(TARGET, d)}`);
    } else {
      fs.copyFileSync(s, d);
      console.log(`  wrote ${path.relative(TARGET, d)}`);
    }
  }
}

function removeLegacyAgents() {
  for (const name of LEGACY_AGENTS) {
    const f = path.join(TARGET, '.claude', 'agents', `${name}.md`);
    if (fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('slow-but-sure')) {
      fs.rmSync(f);
      console.log(`  removed legacy agent ${path.relative(TARGET, f)}`);
    }
  }
}

function mergeSettings() {
  const file = path.join(TARGET, '.claude', 'settings.json');
  let settings = {};
  if (fs.existsSync(file)) {
    try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
      console.error(`  cannot parse ${file}; add the UserPromptSubmit hook manually: ${REMINDER_CMD}`);
      return;
    }
  }
  settings.hooks ??= {};
  let changed = false;
  for (const [event, matcher, command] of [
    ['UserPromptSubmit', undefined, REMINDER_CMD],
    ['PreToolUse', 'Edit|Write|NotebookEdit', GUARD_CMD],
  ]) {
    settings.hooks[event] ??= [];
    if (settings.hooks[event].some((g) => (g.hooks || []).some((h) => h.command === command))) continue;
    settings.hooks[event].push({ ...(matcher && { matcher }), hooks: [{ type: 'command', command }] });
    console.log(`  added ${event} hook to .claude/settings.json`);
    changed = true;
  }
  if (changed) fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  else console.log('  hooks already in .claude/settings.json');
}

function mergeGitignore() {
  const file = path.join(TARGET, '.gitignore');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !have.has(l));
  if (!missing.length) return;
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(file, `${existing}${sep}\n# slow-but-sure\n${missing.join('\n')}\n`);
  console.log(`  .gitignore += ${missing.join(', ')}`);
}

async function installGrillSkills() {
  for (const name of GRILL_SKILLS) {
    const dst = path.join(TARGET, '.claude', 'skills', name, 'SKILL.md');
    if (fs.existsSync(dst) && !force) {
      console.log(`  skip (exists, use --force): ${path.relative(TARGET, dst)}`);
      continue;
    }
    const url = `https://raw.githubusercontent.com/${GRILL_REPO}/${GRILL_SHA}/skills/productivity/${name}/SKILL.md`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download ${name} failed: HTTP ${res.status} ${url}`);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, await res.text());
    console.log(`  wrote ${path.relative(TARGET, dst)} (${GRILL_REPO}@${GRILL_SHA.slice(0, 7)})`);
  }
}

function claude(cliArgs) {
  // shell on Windows so the `claude` shim (.exe/.cmd) resolves from PATH
  return spawnSync('claude', cliArgs, { encoding: 'utf8', shell: process.platform === 'win32' });
}

function installOpendesign() {
  const list = claude(['plugin', 'list', '--json']);
  if (list.error || list.status !== 0) {
    console.log(`  'claude' CLI not found. Install opendesign manually inside Claude Code:
    /plugin marketplace add ${OPENDESIGN_MARKETPLACE}
    /plugin install ${OPENDESIGN_PLUGIN}`);
    return false;
  }
  let plugins = [];
  try { plugins = JSON.parse(list.stdout); } catch {}
  const found = plugins.find((p) => p.id === OPENDESIGN_PLUGIN);
  if (found?.enabled) return console.log(`  ${OPENDESIGN_PLUGIN} already installed (${found.version}, ${found.scope})`), true;
  if (found) {
    const r = claude(['plugin', 'enable', OPENDESIGN_PLUGIN]);
    console.log(r.status === 0 ? `  enabled ${OPENDESIGN_PLUGIN}` : `  failed to enable ${OPENDESIGN_PLUGIN}: ${r.stderr.trim()}`);
    return r.status === 0;
  }
  for (const step of [['plugin', 'marketplace', 'add', OPENDESIGN_MARKETPLACE], ['plugin', 'install', OPENDESIGN_PLUGIN, '--scope', 'user']]) {
    const r = claude(step);
    if (r.status !== 0 && !/already/i.test(r.stdout + r.stderr)) {
      console.log(`  'claude ${step.join(' ')}' failed: ${(r.stderr || r.stdout).trim()}`);
      return false;
    }
  }
  console.log(`  installed ${OPENDESIGN_PLUGIN} (user scope)`);
  return true;
}

console.log(`Installing slow-but-sure into ${TARGET}`);
copyTree(TEMPLATE, TARGET);
removeLegacyAgents();
mergeSettings();
mergeGitignore();
if (noDeps) {
  console.log('Prerequisites skipped (--no-deps): grill-me, grilling, opendesign');
} else {
  console.log('Prerequisites');
  await installGrillSkills();
  installOpendesign();
}
execFileSync(process.execPath, [path.join(TARGET, '.claude/skills/slow-but-sure/scripts/board.mjs'), 'init'], {
  cwd: TARGET, stdio: 'inherit', env: { ...process.env, SBS_ROOT: TARGET },
});
console.log(`
Done. Next:
  1. Review tickets/config.json (commands, integration branch).
  2. Commit the new files; create branch 'dev' if you don't have one.
  3. Restart Claude Code in the project, then: /slow-but-sure on
     (creates .claude/slow-but-sure.models.json: model + effort per role/level; /slow-but-sure models to view)`);
