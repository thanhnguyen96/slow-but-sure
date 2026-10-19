// Worker command: merge a ticket branch into dev and run the merge checks.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { die, now, cell } from '../lib/util.mjs';
import { MAIN, IN_GIT, git, tryGit, worktrees, rel, config, lock, guardMain, commitFiles } from '../lib/repo.mjs';
import { workerOf, by, renderTicket, findTicket, moveTicket, needStatus, epicLog, MERGES_HEADER } from '../lib/tickets.mjs';

function runCheck(name, cmd) {
  const r = spawnSync(cmd, { cwd: MAIN, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { name, cmd, ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`, status: r.status };
}

export function cmdMerge(pos, flags) {
  if (!IN_GIT) die('sbs merge needs a git repository');
  const id = pos[0];
  const here = path.resolve(git(['rev-parse', '--show-toplevel'], process.cwd()));
  lock();
  guardMain(flags, { clean: true });
  const t = findTicket(id);
  needStatus(t, 'in-progress');
  const cfg = config();
  const dev = cfg.integrationBranch;
  const branch = t.fm.branch || `ticket/${t.id}`;
  const who = by(flags, workerOf(t.fm.type));
  if (!tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) die(`branch ${branch} does not exist`);

  // Uncommitted work in the worktree that owns the branch would silently be left out.
  const owner = worktrees().find((w) => w.branch === branch);
  for (const dir of new Set([owner?.path, here !== MAIN ? here : null].filter(Boolean))) {
    const dirty = git(['status', '--porcelain', '--untracked-files=no'], dir);
    if (dirty) die(`uncommitted changes in ${dir}; commit them on ${branch} first:\n${dirty}`);
  }
  const head = git(['rev-parse', '--short', branch]);
  if (git(['rev-list', '--count', `${dev}..${branch}`]) === '0') die(`${branch} has no commits that are not in ${dev}; nothing to merge`);

  const title = t.fm.title;
  const m = spawnSync('git', ['merge', '--no-ff', '--no-commit', branch], { cwd: MAIN, encoding: 'utf8' });
  if (m.status !== 0) {
    const conflicts = tryGit(['diff', '--name-only', '--diff-filter=U']) || '';
    tryGit(['merge', '--abort']);
    console.error(`sbs: CONFLICT merging ${branch} into ${dev}. Nothing was merged; ${dev} is unchanged.`);
    if (conflicts) console.error(`conflicting files:\n${conflicts.split('\n').map((f) => `  ${f}`).join('\n')}`);
    else console.error((m.stdout + m.stderr).trim());
    console.error(`fix: in your worktree run \`git merge ${dev}\`, resolve the conflicts, run the unit/build/lint commands, commit, then run \`sbs merge ${t.id}\` again.`);
    process.exit(2);
  }

  const skipped = [];
  if (!flags['no-checks']) {
    for (const name of cfg.mergeChecks || []) {
      const cmd = cfg.commands[name];
      if (!cmd) { skipped.push(name); continue; }
      process.stdout.write(`check ${name}: ${cmd} ... `);
      const r = runCheck(name, cmd);
      console.log(r.ok ? 'PASS' : `FAIL (exit ${r.status})`);
      if (!r.ok) {
        tryGit(['merge', '--abort']);
        const tail = r.out.trim().split('\n').slice(-40).join('\n');
        console.error(`sbs: ${name} failed on the merged result. Nothing was merged; ${dev} is unchanged.\n--- last lines of \`${cmd}\` ---\n${tail}`);
        console.error(`fix: in your worktree run \`git merge ${dev}\`, run \`${cmd}\` until it passes, commit, then run \`sbs merge ${t.id}\` again.`);
        process.exit(3);
      }
    }
  }

  // The merge commit carries the ticket move, so dev never shows merged code under a stale status.
  const moved = moveTicket(t, 'ready-to-review', `in-progress -> ready-to-review by ${who}: merged ${branch}@${head} into ${dev}`);
  git(['add', '-A', '--', ...moved.map(rel)]);
  git(['commit', '-q', '-m', `merge ${t.id}: ${title}`]);
  const merge = git(['rev-parse', '--short', 'HEAD']);

  const log = epicLog(t.fm.epic, 'merges.md', MERGES_HEADER);
  fs.appendFileSync(log, `| ${now()} | ${t.id} | ${cell(title)} | ${branch} | ${head} | ${merge} | ${who} |\n`);
  const after = findTicket(t.id);
  fs.writeFileSync(after.file, renderTicket({ ...after.fm, merge }, after.body));
  commitFiles([log, after.file], `board: ${t.id} merged as ${merge}`, flags);

  if (flags['no-checks']) console.log('WARNING: --no-checks: the merged result was not checked.');
  else if (skipped.length) console.log(`WARNING: no command for ${skipped.join(', ')} in tickets/config.json; those checks did not run. Tell your lead.`);
  console.log(`${t.id}: merged ${branch}@${head} into ${dev} as ${merge}; status ready-to-review.`);
  console.log(`report to your lead: "${t.id} merged as ${merge}". Keep your worktree until the review is approved.`);
}
