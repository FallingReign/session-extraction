// Copilot CLI session-state survey: what files exist per session, and the full
// event vocabulary across every events.jsonl, with one truncated sample per shape.
// Output goes to probe/*.txt, which is gitignored (it contains session text).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

const ROOT = path.join(os.homedir(), '.copilot', 'session-state');
const OUT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));

function truncate(v, depth = 0) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return v.length > 180 ? v.slice(0, 180) + `…<${v.length}ch>` : v;
  if (Array.isArray(v)) return depth > 4 ? `[${v.length} items]` : v.slice(0, 2).map((x) => truncate(x, depth + 1));
  if (typeof v === 'object') {
    if (depth > 5) return '{…}';
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = truncate(val, depth + 1);
    return o;
  }
  return v;
}

const dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'));
const layouts = new Map();
const types = new Map();
const dataKeys = new Map();
const toolNames = new Map();
const samples = new Map();
let files = 0;
let bytes = 0;

for (const d of dirs) {
  const dir = path.join(ROOT, d.name);
  const names = fs.readdirSync(dir).filter((n) => !n.startsWith('inuse.')).sort();
  const layout = names.join(',');
  layouts.set(layout, (layouts.get(layout) ?? 0) + 1);
  const ev = path.join(dir, 'events.jsonl');
  if (!fs.existsSync(ev)) continue;
  files++;
  bytes += fs.statSync(ev).size;
  const rl = readline.createInterface({ input: fs.createReadStream(ev, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { types.set('PARSE_FAIL', (types.get('PARSE_FAIL') ?? 0) + 1); continue; }
    types.set(o.type, (types.get(o.type) ?? 0) + 1);
    const keys = Object.keys(o.data ?? {}).sort().join(',');
    const dk = `${o.type} :: ${keys}`;
    dataKeys.set(dk, (dataKeys.get(dk) ?? 0) + 1);
    if (o.data?.toolName) toolNames.set(o.data.toolName, (toolNames.get(o.data.toolName) ?? 0) + 1);
    const sk = o.type + (o.data?.toolName ? `|${o.data.toolName}` : '');
    if (!samples.has(sk)) samples.set(sk, truncate(o));
  }
  rl.close();
}

const lines = [];
lines.push(`session dirs: ${dirs.length}  with events.jsonl: ${files}  total ${(bytes / 1e6).toFixed(0)}MB`);
lines.push('\n=== DIRECTORY LAYOUTS ===');
for (const [k, c] of [...layouts].sort((a, b) => b[1] - a[1]).slice(0, 25)) lines.push(`${String(c).padStart(5)}  ${k}`);
lines.push('\n=== EVENT TYPES ===');
for (const [k, c] of [...types].sort((a, b) => b[1] - a[1])) lines.push(`${String(c).padStart(9)}  ${k}`);
lines.push('\n=== DATA KEY SHAPES ===');
for (const [k, c] of [...dataKeys].sort((a, b) => b[1] - a[1])) lines.push(`${String(c).padStart(9)}  ${k}`);
lines.push('\n=== TOOL NAMES ===');
for (const [k, c] of [...toolNames].sort((a, b) => b[1] - a[1])) lines.push(`${String(c).padStart(9)}  ${k}`);
fs.writeFileSync(path.join(OUT, 'copilot-vocab.txt'), lines.join('\n'));

const s = [];
for (const [k, v] of samples) s.push(`\n--- ${k} ---\n${JSON.stringify(v, null, 1)}`);
fs.writeFileSync(path.join(OUT, 'copilot-samples.txt'), s.join('\n'));
console.log(lines.slice(0, 3).join('\n'));
console.log(`types: ${types.size}  shapes: ${dataKeys.size}  tools: ${toolNames.size}  samples: ${samples.size}`);
