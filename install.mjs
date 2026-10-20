#!/usr/bin/env node
// Install slow-but-sure into a target project, plus its prerequisites:
//   - grill-me + grilling skills (mattpocock/skills, pinned commit) into <target>/.claude/skills/
//   - opendesign Claude Code plugin (manalkaff/opendesign), user scope, via the `claude` CLI
// Usage: node install.mjs [target-project-dir] [--force] [--no-deps]   (target defaults to the current directory)
//        npx github:thanhnguyen96/slow-but-sure [target] [--force] [--no-deps]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(HERE, 'template');
const REMINDER_CMD = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/sbs-reminder.mjs"';
// The guard lives in project settings (not agent frontmatter): frontmatter hooks need the
// workspace-trust dialog and never run in -p sessions. The script itself filters on agent_type.
const GUARD_CMD = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/sbs-guard.mjs"';
const GUARD_MATCHER = 'Edit|Write|NotebookEdit|Bash';
// Without it, auto mode's classifier blocks `sbs merge` (a worker writing the main checkout's dev branch) and
// agents cannot add the rule themselves. The guard still limits which sbs commands each role runs.
const SBS_ALLOW = 'Bash(node .claude/skills/slow-but-sure/scripts/sbs.mjs:*)';
// Hook commands and files of older versions (the interim simple-workflow name, the first tester guard), removed on install.
const LEGACY_HOOK_CMDS = ['node "$CLAUDE_PROJECT_DIR/.claude/hooks/sw-reminder.mjs"', 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/sw-guard.mjs"', 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/sbs-tester-guard.mjs"'];
const LEGACY_PATHS = ['.claude/hooks/sw-reminder.mjs', '.claude/hooks/sw-guard.mjs', '.claude/hooks/sbs-tester-guard.mjs', '.claude/skills/simple-workflow', '.claude/skills/sw', '.claude/skills/sw-context'];
const GITIGNORE_LINES = ['.claude/slow-but-sure.on', '.claude/settings.local.json', '.claude/worktrees/', 'test-results/', 'playwright-report/', 'opendesign/'];

// Agent files from older versions (roles are now lead-dev/dev/reviewer/lead-qa/qa).
const LEGACY_AGENTS = ['senior-dev', 'junior-dev', 'senior-tester', 'junior-tester', 'dev-lead', 'tester-lead', 'tester'];

const GRILL_REPO = 'mattpocock/skills';
const GRILL_SHA = '49dd158d1076134a641b33efb035946536778336';
const GRILL_SKILLS = ['grill-me', 'grilling'];
const OPENDESIGN_MARKETPLACE = 'manalkaff/opendesign';
const OPENDESIGN_PLUGIN = 'opendesign@opendesign';

const args = process.argv.slice(2);
const force = args.includes('--force');
const noDeps = args.includes('--no-deps');
if (args.includes('--help') || args.includes('-h')) {
  console.log('usage: node install.mjs [target-project-dir] [--force] [--no-deps]   (target defaults to the current directory)');
  process.exit(0);
}
const TARGET = path.resolve(args.find((a) => !a.startsWith('-')) || '.');
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
    if (fs.existsSync(f) && /slow-but-sure|simple-workflow/.test(fs.readFileSync(f, 'utf8'))) {
      fs.rmSync(f);
      console.log(`  removed legacy agent ${path.relative(TARGET, f)}`);
    }
  }
  for (const p of LEGACY_PATHS) {
    const f = path.join(TARGET, p);
    if (!fs.existsSync(f)) continue;
    fs.rmSync(f, { recursive: true, force: true });
    console.log(`  removed legacy ${p}`);
  }
  // The interim simple-workflow name: carry the ON flag and the models file over once.
  const claudeDir = path.join(TARGET, '.claude');
  for (const [from, to] of [['simple-workflow.on', 'slow-but-sure.on'], ['simple-workflow.models.json', 'slow-but-sure.models.json']]) {
    const src = path.join(claudeDir, from);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(path.join(claudeDir, to))) fs.rmSync(src);
    else fs.renameSync(src, path.join(claudeDir, to));
    console.log(`  migrated .claude/${from} -> ${to}`);
  }
  // The first slow-but-sure models file used dev-lead / tester-lead keys.
  const models = path.join(claudeDir, 'slow-but-sure.models.json');
  try {
    const m = JSON.parse(fs.readFileSync(models, 'utf8'));
    if (m['dev-lead'] || m['tester-lead']) {
      fs.writeFileSync(models, JSON.stringify({ 'lead-dev': m['dev-lead'], 'lead-qa': m['tester-lead'], levels: m.levels }, null, 2) + '\n');
      console.log('  migrated .claude/slow-but-sure.models.json keys (dev-lead, tester-lead -> lead-dev, lead-qa)');
    }
  } catch {}
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
  for (const event of Object.keys(settings.hooks)) {
    const before = JSON.stringify(settings.hooks[event]);
    settings.hooks[event] = settings.hooks[event]
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !LEGACY_HOOK_CMDS.includes(h.command)) }))
      .filter((g) => g.hooks.length);
    if (JSON.stringify(settings.hooks[event]) !== before) { console.log(`  removed legacy ${event} hook`); changed = true; }
  }
  for (const [event, matcher, command] of [
    ['UserPromptSubmit', undefined, REMINDER_CMD],
    ['PreToolUse', GUARD_MATCHER, GUARD_CMD],
  ]) {
    settings.hooks[event] ??= [];
    const existing = settings.hooks[event].find((g) => (g.hooks || []).some((h) => h.command === command));
    if (existing) {
      // Older installs ran the guard only on Edit|Write|NotebookEdit.
      if (matcher && existing.matcher !== matcher) {
        existing.matcher = matcher;
        console.log(`  updated ${event} hook matcher to ${matcher}`);
        changed = true;
      }
      continue;
    }
    settings.hooks[event].push({ ...(matcher && { matcher }), hooks: [{ type: 'command', command }] });
    console.log(`  added ${event} hook to .claude/settings.json`);
    changed = true;
  }
  settings.permissions ??= {};
  settings.permissions.allow ??= [];
  if (!settings.permissions.allow.includes(SBS_ALLOW)) {
    settings.permissions.allow.push(SBS_ALLOW);
    console.log(`  added permission ${SBS_ALLOW} to .claude/settings.json`);
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
execFileSync(process.execPath, [path.join(TARGET, '.claude/skills/slow-but-sure/scripts/sbs.mjs'), 'init'], {
  cwd: TARGET, stdio: 'inherit', env: { ...process.env, SBS_ROOT: TARGET },
});
console.log(`
Done. Next:
  1. Review tickets/config.json (commands, integration branch).
  2. Commit the new files; create branch 'dev' if you don't have one.
  3. Restart Claude Code in the project, then: /sbs on   (alias of /slow-but-sure)
     (creates .claude/slow-but-sure.models.json: model + effort per role/level; /sbs models to view)`);
