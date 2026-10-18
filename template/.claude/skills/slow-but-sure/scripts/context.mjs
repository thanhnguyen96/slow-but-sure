#!/usr/bin/env node
// Context usage of the PM and its subagents, read from the session transcripts.
// Usage: node context.mjs [sessionId] [--all]
//   sessionId  defaults to the most recently written session of this project
//   --all      include finished subagents (default: running only, plus totals)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const showAll = args.includes('--all');
let sessionId = args.find(a => !a.startsWith('--') && !a.startsWith('$'));

const projectsDir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const projDir = path.join(projectsDir, process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
if (!fs.existsSync(projDir)) {
  console.log(`No transcripts for this project (${projDir}).`);
  process.exit(0);
}

if (!sessionId) {
  const sessions = fs.readdirSync(projDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({ id: f.slice(0, -6), t: fs.statSync(path.join(projDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!sessions.length) { console.log('No session found.'); process.exit(0); }
  sessionId = sessions[0].id;
}

function lastUsage(file) {
  let model = '?', ctx = 0, out = 0, turns = 0, last = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"usage"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const u = e.type === 'assistant' && e.message?.usage;
    if (!u) continue;
    model = e.message.model || model;
    ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    out += u.output_tokens || 0;
    turns++;
    last = e.timestamp;
  }
  return { model, ctx, out, turns, last };
}

const k = n => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const ago = ts => {
  if (!ts) return '-';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(ts)) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};

const rows = [];
const main = path.join(projDir, `${sessionId}.jsonl`);
if (fs.existsSync(main)) rows.push({ id: '', depth: 0, type: 'PM (main)', desc: '', state: 'main', ...lastUsage(main) });

const subDir = path.join(projDir, sessionId, 'subagents');
const subs = [];
if (fs.existsSync(subDir)) {
  for (const f of fs.readdirSync(subDir).filter(f => f.endsWith('.jsonl'))) {
    const id = f.replace(/^agent-/, '').replace(/\.jsonl$/, '');
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(subDir, `agent-${id}.meta.json`), 'utf8')); } catch {}
    subs.push({
      id,
      parent: meta.parentAgentId || '',
      depth: meta.spawnDepth || 1,
      type: meta.agentType || '?',
      desc: meta.description || '',
      state: meta.finished ? 'done' : 'running',
      ...lastUsage(path.join(subDir, f)),
    });
  }
}

// Leads first, each followed by its workers, in start order.
subs.sort((a, b) => String(a.last).localeCompare(String(b.last)));
const shown = subs.filter(s => showAll || s.state === 'running');
const byParent = id => shown.filter(s => s.parent === id);
const placed = new Set();
const walk = (s) => { if (placed.has(s.id)) return; placed.add(s.id); rows.push(s); byParent(s.id).forEach(walk); };
shown.filter(s => !s.parent || !shown.some(p => p.id === s.parent)).forEach(walk);

const head = ['AGENT', 'MODEL', 'CONTEXT', 'OUT', 'TURNS', 'LAST', 'STATE', 'TASK'];
const table = rows.map(r => [
  `${'  '.repeat(Math.max(0, r.depth - 1))}${r.depth ? '└ ' : ''}${r.type}`,
  r.model, k(r.ctx), k(r.out), String(r.turns), ago(r.last), r.state, r.desc,
]);
const w = head.map((h, i) => Math.max(h.length, ...table.map(t => t[i].length)));
const fmt = t => t.map((c, i) => (i === t.length - 1 ? c : c.padEnd(w[i]))).join('  ');

console.log(`Session ${sessionId}`);
console.log(fmt(head));
table.forEach(t => console.log(fmt(t)));
const running = subs.filter(s => s.state === 'running').length;
const totalOut = subs.reduce((a, s) => a + s.out, 0);
console.log(`\nSubagents: ${running} running, ${subs.length - running} done, ${k(totalOut)} output tokens in total.` +
  (showAll || subs.length === running ? '' : ' Use --all to list finished ones.'));
console.log('CONTEXT = tokens sent on the agent\'s latest request (its current context size).');
