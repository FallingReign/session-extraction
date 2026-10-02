// Targeted Copilot probe: exit codes, failure shapes, user.message sources,
// assistant.message phases, reasoning text, and per-tool failure rates.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

const ROOT = path.join(os.homedir(), '.copilot', 'session-state');
const OUT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const t = (s, n = 300) => (typeof s === 'string' ? (s.length > n ? s.slice(0, n) + `…<${s.length}>` : s) : s);

const counters = {
  userSource: new Map(),
  userDelivery: new Map(),
  phase: new Map(),
  hasReasoningText: 0,
  hasEncryptedOnly: 0,
  completeKeys: new Map(),
  shellExecKeys: new Map(),
  failByTool: new Map(),
  callsByTool: new Map(),
  resultKeys: new Map(),
  errorKeys: new Map(),
  notifKinds: new Map(),
  infoTypes: new Map(),
  missingStart: 0,
};
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
const samples = { shellFail: [], shellOk: [], errorShape: [], userSourced: [], userTransformed: [], phases: [], editResult: [], subagentMsg: [] };
const keep = (arr, v, n = 3) => { if (arr.length < n) arr.push(v); };

const dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'));
for (const d of dirs) {
  const ev = path.join(ROOT, d.name, 'events.jsonl');
  if (!fs.existsSync(ev)) continue;
  const starts = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(ev, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const x = o.data ?? {};
    switch (o.type) {
      case 'user.message':
        bump(counters.userSource, x.source ?? '(none)');
        bump(counters.userDelivery, x.delivery ?? '(none)');
        if (x.source) keep(samples.userSourced, { source: x.source, content: t(x.content, 400) }, 8);
        if (x.transformedContent && x.transformedContent !== x.content) {
          keep(samples.userTransformed, { content: t(x.content, 200), transformedHead: t(x.transformedContent, 500), attachments: x.attachments?.length }, 4);
        }
        break;
      case 'assistant.message':
        bump(counters.phase, x.phase ?? '(none)');
        if (x.reasoningText) counters.hasReasoningText++;
        else if (x.reasoningOpaque || x.encryptedContent) counters.hasEncryptedOnly++;
        if (x.phase) keep(samples.phases, { phase: x.phase, content: t(x.content, 200), tools: (x.toolRequests ?? []).map((r) => r.name) }, 6);
        if (x.parentToolCallId) keep(samples.subagentMsg, { parent: x.parentToolCallId, content: t(x.content, 200) }, 2);
        break;
      case 'tool.execution_start':
        starts.set(x.toolCallId, x);
        bump(counters.callsByTool, x.toolName);
        break;
      case 'tool.execution_complete': {
        const st = starts.get(x.toolCallId);
        if (!st) counters.missingStart++;
        const tool = st?.toolName ?? '(unknown)';
        bump(counters.completeKeys, Object.keys(x).sort().join(','));
        if (x.result) bump(counters.resultKeys, Object.keys(x.result).sort().join(','));
        if (x.error) bump(counters.errorKeys, typeof x.error === 'string' ? 'string' : Object.keys(x.error).sort().join(','));
        if (x.success === false) bump(counters.failByTool, tool);
        if (x.shellExecution) bump(counters.shellExecKeys, Object.keys(x.shellExecution).sort().join(','));
        if (tool === 'powershell') {
          const v = { success: x.success, shellExecution: x.shellExecution, error: x.error, result: { content: t(x.result?.content, 400), detailedHead: t(x.result?.detailedContent, 200) }, cmd: t(st?.arguments?.command, 150) };
          if (x.success === false || x.shellExecution?.exitCode) keep(samples.shellFail, v, 4);
          else keep(samples.shellOk, v, 2);
        }
        if (x.error) keep(samples.errorShape, { tool, error: x.error }, 5);
        if ((tool === 'edit' || tool === 'create' || tool === 'apply_patch') ) keep(samples.editResult, { tool, success: x.success, result: { content: t(x.result?.content, 300), detailed: t(x.result?.detailedContent, 300) } }, 4);
        break;
      }
      case 'system.notification':
        bump(counters.notifKinds, x.kind?.type ?? '(none)');
        break;
      case 'session.info':
        bump(counters.infoTypes, x.infoType ?? '(none)');
        break;
      default:
    }
  }
  rl.close();
}

const out = [];
const dump = (name, m) => {
  out.push(`\n=== ${name} ===`);
  for (const [k, v] of [...m].sort((a, b) => b[1] - a[1]).slice(0, 40)) out.push(`${String(v).padStart(8)}  ${k}`);
};
dump('user.message source', counters.userSource);
dump('user.message delivery', counters.userDelivery);
dump('assistant.message phase', counters.phase);
out.push(`\nreasoningText present: ${counters.hasReasoningText}  encrypted-only: ${counters.hasEncryptedOnly}  completes without start: ${counters.missingStart}`);
dump('tool.execution_complete keys', counters.completeKeys);
dump('result keys', counters.resultKeys);
dump('error keys', counters.errorKeys);
dump('shellExecution keys', counters.shellExecKeys);
dump('failures by tool', counters.failByTool);
dump('notification kinds', counters.notifKinds);
dump('session.info types', counters.infoTypes);
for (const [k, v] of Object.entries(samples)) out.push(`\n=== sample: ${k} ===\n${JSON.stringify(v, null, 1)}`);
fs.writeFileSync(path.join(OUT, 'copilot-details.txt'), out.join('\n'));
console.log('written', out.length, 'lines');
