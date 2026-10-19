// The app server and the e2e suite: start/stop in the background with a recorded pid, setup/teardown around e2e,
// and screenshots of the app or the mockups.
// Agents never start servers or Playwright themselves (a foreground server blocks the shell until its timeout,
// a background one is easily left running), so every start goes through here and every stop frees the port.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { die, readJSON, writeJSON } from '../lib/util.mjs';
import { MAIN, IN_GIT, EPICS, git, config, lock, rel } from '../lib/repo.mjs';

const START_WAIT_S = 60;
const E2E_TIMEOUT_S = 540; // under the 10-minute Bash tool limit, so the teardown always runs

// The checkout the command runs in: a worker's worktree, or the main checkout.
const here = () => (IN_GIT ? path.resolve(git(['rev-parse', '--show-toplevel'], process.cwd())) : process.cwd());
const stateFile = () => path.resolve(MAIN, IN_GIT ? git(['rev-parse', '--git-common-dir']) : '.', 'sbs-app.json');

function playwrightConfig(dir) {
  const f = fs.readdirSync(dir).find((n) => /^playwright\.config\.(m?[jt]s|c[jt]s)$/.test(n));
  return f ? fs.readFileSync(path.join(dir, f), 'utf8') : '';
}

// tickets/config.json "port", else the port of baseURL in playwright.config.*.
function appPort(dir) {
  const cfg = config();
  if (cfg.port) return Number(cfg.port);
  const m = playwrightConfig(dir).match(/baseURL\s*:\s*['"`]https?:\/\/[^/'"`]*?:(\d+)/);
  if (m) return Number(m[1]);
  die('cannot tell the app port: set "port" in tickets/config.json or baseURL in playwright.config.*');
}

function answers(port, host) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    s.setTimeout(1000);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}
const portBusy = async (port) => (await answers(port, '127.0.0.1')) || (await answers(port, '::1'));

// Pids listening on the port.
function portOwners(port) {
  if (process.platform === 'win32') {
    const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout || '';
    return [...new Set(out.split(/\r?\n/).map((l) => l.trim().split(/\s+/))
      .filter((c) => c[0] === 'TCP' && c[3] === 'LISTENING' && c[1].endsWith(`:${port}`)).map((c) => Number(c[4])).filter(Boolean))];
  }
  const out = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout || '';
  return out.split('\n').map(Number).filter(Boolean);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Kills the process and its children (npm start -> node server.js).
function killTree(pid) {
  if (!pid || !alive(pid)) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
  }
}

async function waitFor(check, seconds) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function startApp(dir, port) {
  const cmd = config().commands.app;
  if (!cmd) die('no "app" command in tickets/config.json commands');
  const state = readJSON(stateFile(), null);
  if (state && alive(state.pid) && await portBusy(port)) {
    if (path.resolve(state.cwd) === dir) return { ...state, reused: true };
    die(`the app is already running from ${state.cwd} (pid ${state.pid}). Run \`sbs app stop\` first, or wait for whoever started it.`);
  }
  if (await portBusy(port)) die(`port ${port} is in use by pid ${portOwners(port).join(', ') || '?'}, not by an app sbs started. \`sbs app stop\` frees it.`);
  const log = path.join(os.tmpdir(), `sbs-app-${port}.log`);
  const fd = fs.openSync(log, 'w');
  const child = spawn(cmd, { cwd: dir, shell: true, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
  child.unref();
  fs.closeSync(fd);
  const started = { pid: child.pid, port, cwd: dir, cmd, log, url: `http://localhost:${port}` };
  writeJSON(stateFile(), started);
  if (!await waitFor(() => portBusy(port), START_WAIT_S)) {
    await stopApp(port);
    const tail = fs.readFileSync(log, 'utf8').trim().split('\n').slice(-20).join('\n');
    die(`\`${cmd}\` did not answer on port ${port} within ${START_WAIT_S}s. Last lines of ${log}:\n${tail}`);
  }
  return started;
}

// Stops the recorded app, then anything still listening on the port.
async function stopApp(port) {
  const state = readJSON(stateFile(), null);
  if (state) killTree(state.pid);
  fs.rmSync(stateFile(), { force: true });
  if (await waitFor(async () => !await portBusy(port), 10)) return true;
  for (const pid of portOwners(port)) killTree(pid);
  return waitFor(async () => !await portBusy(port), 10);
}

export async function cmdApp(pos) {
  const sub = pos[0] || 'status';
  const dir = here();
  const port = appPort(dir);
  if (sub === 'start') {
    const s = await startApp(dir, port);
    console.log(`${s.reused ? 'already running' : 'started'}: ${s.url}  (pid ${s.pid}, from ${s.cwd}, log ${s.log})`);
    console.log('Stop it with `sbs app stop` when you are done.');
  } else if (sub === 'stop') {
    console.log(await stopApp(port) ? `stopped; port ${port} is free` : `port ${port} is still in use by pid ${portOwners(port).join(', ')}`);
  } else if (sub === 'status') {
    const state = readJSON(stateFile(), null);
    const busy = await portBusy(port);
    if (state && alive(state.pid) && busy) console.log(`running: ${state.url}  (pid ${state.pid}, from ${state.cwd}, log ${state.log})`);
    else console.log(busy ? `port ${port} is in use by pid ${portOwners(port).join(', ') || '?'} (not started by sbs)` : `not running; port ${port} is free`);
  } else die('usage: sbs app <start|stop|status>');
}

// Setup, run, teardown. Playwright with a webServer starts the app itself; otherwise sbs starts commands.app.
export async function cmdE2e() {
  // Raw arguments: Playwright flags (-g, --repeat-each) pass through untouched.
  const extra = process.argv.slice(process.argv.indexOf('e2e') + 1);
  const cfg = config();
  if (!cfg.commands.e2e) die('no "e2e" command in tickets/config.json commands');
  const dir = here();
  const port = appPort(dir);
  lock('e2e', 'e2e suite');
  const own = !/webServer\s*:/.test(playwrightConfig(dir));
  if (await portBusy(port)) await stopApp(port);
  let code = 1;
  try {
    if (own) {
      const s = await startApp(dir, port);
      console.log(`app: ${s.url} (pid ${s.pid})`);
    }
    let cmd = cfg.commands.e2e;
    if (/playwright/.test(cmd) && !/--reporter/.test(cmd)) cmd += ' --reporter=line';
    if (extra.length) cmd += ` ${extra.map((a) => (/^[\w./:=@-]+$/.test(a) ? a : JSON.stringify(a))).join(' ')}`;
    console.log(`$ ${cmd}`);
    const r = spawnSync(cmd, { cwd: dir, shell: true, stdio: 'inherit', timeout: E2E_TIMEOUT_S * 1000, env: { ...process.env, CI: '1' } });
    if (r.error?.code === 'ETIMEDOUT') console.error(`sbs: e2e stopped after ${E2E_TIMEOUT_S}s. Run a subset: sbs e2e <spec file or -g "name">`);
    code = r.status ?? 1;
  } finally {
    console.log(await stopApp(port) ? `teardown: app stopped, port ${port} free` : `teardown: port ${port} still in use by pid ${portOwners(port).join(', ')}`);
  }
  process.exitCode = code;
}

// Playwright's chromium from the project's own dependencies.
async function chromium(dir) {
  const req = createRequire(path.join(dir, 'package.json'));
  for (const name of ['@playwright/test', 'playwright']) {
    let file;
    try { file = req.resolve(name); } catch { continue; }
    const mod = await import(pathToFileURL(file).href);
    return mod.chromium || mod.default.chromium;
  }
  die('Playwright is not installed in this project (npm i -D @playwright/test, then npx playwright install chromium)');
}

const VIEWPORT = { width: 1280, height: 720 };

// Screenshots of the app (one PNG per page/state) or of the epic's HTML mockups, at the same viewport.
export async function cmdShot(pos, flags) {
  const usage = 'usage: sbs shot -e <epic> <name> [--path /route] | sbs shot -e <epic> --setup <file.mjs> | sbs shot -e <epic> --mockups';
  if (typeof flags.epic !== 'string') die(usage);
  const epicDir = path.join(EPICS, flags.epic);
  if (!fs.existsSync(epicDir)) die(`no epic folder ${rel(epicDir)}`);
  const dir = here();
  const browser = await (await chromium(dir)).launch();
  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    if (flags.mockups) {
      const mdir = path.join(epicDir, 'mockups');
      const files = fs.existsSync(mdir) ? fs.readdirSync(mdir).filter((n) => /\.html?$/i.test(n)) : [];
      if (!files.length) die(`no HTML mockups in ${rel(mdir)}`);
      for (const f of files) {
        const out = path.join(mdir, f.replace(/\.html?$/i, '.png'));
        await page.goto(pathToFileURL(path.join(mdir, f)).href);
        await page.screenshot({ path: out, fullPage: true });
        console.log(`  ${rel(out)}`);
      }
      return;
    }
    const setup = typeof flags.setup === 'string' ? path.resolve(flags.setup) : null;
    if (!setup && !pos[0]) die(usage);
    const port = appPort(dir);
    const app = await startApp(dir, port);
    const baseURL = `http://localhost:${port}`;
    const outDir = path.join(epicDir, 'screenshots');
    fs.mkdirSync(outDir, { recursive: true });
    const shot = async (name) => {
      const out = path.join(outDir, `${name}.png`);
      await page.screenshot({ path: out, fullPage: true });
      console.log(`  ${rel(out)}`);
    };
    try {
      if (setup) await (await import(pathToFileURL(setup).href)).default({ page, baseURL, shot });
      else {
        await page.goto(baseURL + (typeof flags.path === 'string' ? flags.path : '/'));
        await page.waitForLoadState('networkidle');
        await shot(pos[0]);
      }
    } finally {
      if (!app.reused) await stopApp(port);
    }
  } finally {
    await browser.close();
  }
}
