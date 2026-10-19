// Setup commands: models table, workflow on/off flag.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_MODELS, MODEL_ROWS, MODEL_NOTES, EFFORT_NOTES, AGENT_MODELS, EFFORTS } from '../lib/constants.mjs';
import { die, now, writeJSON } from '../lib/util.mjs';
import { FLAG, MODELS_FILE, rel } from '../lib/repo.mjs';

function loadModels() {
  if (!fs.existsSync(MODELS_FILE)) {
    fs.mkdirSync(path.dirname(MODELS_FILE), { recursive: true });
    writeJSON(MODELS_FILE, DEFAULT_MODELS);
    console.log(`created ${rel(MODELS_FILE)} (edit it to change models/effort)`);
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8')); } catch (e) { die(`cannot parse ${MODELS_FILE}: ${e.message}`); }
  const m = {
    'lead-dev': raw['lead-dev'] || DEFAULT_MODELS['lead-dev'],
    'lead-qa': raw['lead-qa'] || DEFAULT_MODELS['lead-qa'],
    reviewer: raw.reviewer || DEFAULT_MODELS.reviewer,
    levels: { ...DEFAULT_MODELS.levels, ...(raw.levels || {}) },
  };
  for (const [name, get] of MODEL_ROWS) {
    const v = get(m) || {};
    if (!AGENT_MODELS.includes(v.model)) die(`${name}.model '${v.model}' invalid in ${MODELS_FILE}. Use one of ${AGENT_MODELS.join(', ')}`);
    if (!EFFORTS.includes(v.effort)) die(`${name}.effort '${v.effort}' invalid. Use one of ${EFFORTS.join(', ')}`);
  }
  return m;
}

function printModels(m) {
  console.log(`slow-but-sure models (${rel(MODELS_FILE)})`);
  console.log(`  ${'ROLE'.padEnd(12)} ${'MODEL'.padEnd(26)} ${'EFFORT'.padEnd(26)} USED FOR`);
  for (const [name, get, use] of MODEL_ROWS) {
    const v = get(m);
    const model = `${v.model}${MODEL_NOTES[v.model] ? ` (${MODEL_NOTES[v.model]})` : ''}`;
    const effort = `${v.effort} (${EFFORT_NOTES[v.effort]})`;
    console.log(`  ${name.padEnd(12)} ${model.padEnd(26)} ${effort.padEnd(26)} ${use}`);
  }
  console.log('  Workers start at junior; each reopen of a ticket raises it one level, up to senior.');
}

export function cmdModels(pos, flags) {
  const m = loadModels();
  if (flags.json) return console.log(JSON.stringify(m, null, 2));
  printModels(m);
}

export function cmdMode(pos) {
  const v = pos[0] || 'status';
  if (v === 'on') {
    fs.mkdirSync(path.dirname(FLAG), { recursive: true });
    if (!fs.existsSync(FLAG)) fs.writeFileSync(FLAG, `enabled ${now()}\n`);
    printModels(loadModels());
  } else if (v === 'off') {
    fs.rmSync(FLAG, { force: true });
  } else if (v !== 'status') {
    die('usage: sbs mode <on|off|status>');
  }
  console.log(`slow-but-sure: ${fs.existsSync(FLAG) ? 'ON' : 'OFF'}`);
}
