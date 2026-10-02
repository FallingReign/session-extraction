// How do powershell results encode exit status when shellExecution is absent?
// Also: what do workspace.yaml files look like across all sessions?
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

const ROOT = path.join(os.homedir(), '.copilot', 'session-state');
const tails = new Map();
const yamlKeys = new Map();
const yamlOdd = [];
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
let withExec = 0, withoutExec = 0, failNoExec = 0;
const asyncSamples = [];

for (const d of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (!d.isDirectory() || d.name.startsWith('.')) continue;
  const ws = path.join(ROOT, d.name, 'workspace.yaml');
  if (fs.existsSync(ws)) {
    for (const line of fs.readFileSync(ws, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Za-z_]+):(.*)$/.exec(line);
      if (m) {
        bump(yamlKeys, m[1]);
        const v = m[2].trim();
        if (/^[|>]/.test(v) && yamlOdd.length < 4) yamlOdd.push({ key: m[1], v, file: d.name });
      } else if (line.trim() && yamlOdd.length < 8) yamlOdd.push({ continuation: line.slice(0, 120), file: d.name });
    }
  }
  const ev = path.join(ROOT, d.name, 'events.jsonl');
  if (!fs.existsSync(ev)) continue;
  const starts = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(ev, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('powershell') && !line.includes('tool.execution_complete')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const x = o.data ?? {};
    if (o.type === 'tool.execution_start' && x.toolName === 'powershell') starts.set(x.toolCallId, x);
    if (o.type !== 'tool.execution_complete' || !starts.has(x.toolCallId)) continue;
    const st = starts.get(x.toolCallId);
    if (x.shellExecution) { withExec++; continue; }
    withoutExec++;
    if (x.success === false) failNoExec++;
    const c = String(x.result?.content ?? '');
    const tail = c.slice(-80).replace(/\d+/g, 'N').replace(/\s+/g, ' ').trim();
    const m = /<[^<>]*(exit code|exited)[^<>]*>\s*$/i.exec(c);
    bump(tails, m ? m[0].replace(/\d+/g, 'N') : (st.arguments?.mode === 'async' ? `ASYNC: ${tail.slice(-50)}` : `OTHER: ${tail.slice(-40)}`));
    if (st.arguments?.mode === 'async' && asyncSamples.length < 3) asyncSamples.push(c.slice(0, 200));
  }
  rl.close();
}

console.log(`powershell completes: with shellExecution ${withExec}, without ${withoutExec} (of which success=false ${failNoExec})`);
console.log('\n=== result endings without shellExecution (top 25) ===');
for (const [k, v] of [...tails].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(String(v).padStart(7), k);
console.log('\n=== workspace.yaml keys ===');
for (const [k, v] of [...yamlKeys].sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(7), k);
console.log('\n=== unusual yaml lines ===');
console.log(JSON.stringify(yamlOdd, null, 1));
console.log('\n=== async samples ===');
console.log(JSON.stringify(asyncSamples, null, 1));
