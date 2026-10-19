// Process, time, string and JSON helpers.
import fs from 'node:fs';

export function die(msg, code = 1) {
  console.error(`sw: ${msg}`);
  process.exit(code);
}

export function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function today() {
  return now().slice(0, 10).replace(/-/g, '');
}

export function slugify(s) {
  const slug = s.replace(/[đĐ]/g, 'd').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '');
  return slug || 'ticket';
}

export function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJSON(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

// Escapes a value for a markdown table cell.
export const cell = (s) => String(s ?? '').replace(/\|/g, '\|').replace(/\r?\n/g, ' ');
