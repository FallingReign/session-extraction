#!/usr/bin/env node
/**
 * Fidelity + robustness harness.
 *
 * For a sample of sessions from each source, independently recount the facts
 * a packet must never lose (commands, failures, files touched) straight from
 * the raw records, and assert the packet agrees exactly. The recount
 * deliberately shares no code with the adapters it checks.
 *
 *   node scripts/verify.mjs [--source codex|copilot] [--sample=40] [--max-bytes=30000000]
 */
import path from 'node:path';
import { streamRecords } from '../src/core/jsonl.mjs';
import { listSessions, adapterFor, ADAPTERS } from '../src/core/sources.mjs';
import { renderMarkdown } from '../src/core/render-markdown.mjs';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=')[1];
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const maxBytes = Number(arg('max-bytes', 30e6));
const sampleSize = Number(arg('sample', 40));
const onlySource = arg('source', null);

process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /sqlite/i.test(w.message)) return;
  console.error(String(w));
});

/** Ground-truth counters, one per source format. */
const GROUND_TRUTH = {
  async copilot(ref) {
    const truth = { commands: 0, failures: 0, files: new Set() };
    const SHELL = /^(powershell|bash|shell|local_shell)$/;
    const EDIT = /^(edit|str_replace|str-replace|create)$/;
    const starts = new Map();
    let cwd = ref.cwd;
    const abs = (p) => (path.isAbsolute(p) || !cwd ? p : path.resolve(cwd, p));
    for await (const { rec } of streamRecords(ref.files)) {
      const d = rec.data ?? {};
      if (rec.type === 'session.start' || rec.type === 'session.resume') cwd = d.context?.cwd ?? cwd;
      if (rec.type === 'session.context_changed') cwd = d.cwd ?? cwd;
      if (rec.type === 'tool.execution_start') starts.set(d.toolCallId, d);
      if (rec.type !== 'tool.execution_complete') continue;
      const s = starts.get(d.toolCallId);
      if (!s) continue;
      if (SHELL.test(s.toolName)) {
        truth.commands++;
        const tail = /exit code (-?\d+)>\s*$/.exec(String(d.result?.content ?? ''));
        const code = d.shellExecution?.exitCode ?? (tail ? Number(tail[1]) : 0);
        if (d.success === false || code !== 0) truth.failures++;
      } else if (d.success !== false && EDIT.test(s.toolName) && s.arguments?.path) {
        truth.files.add(abs(s.arguments.path));
      } else if (d.success !== false && s.toolName === 'apply_patch') {
        const patch = typeof s.arguments === 'string' ? s.arguments : (s.arguments?.input ?? '');
        // Both sides of a move count as changed paths.
        for (const m of patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+?)\s*$/gm)) {
          truth.files.add(abs(m[1]));
        }
      }
    }
    return truth;
  },

  async codex(ref) {
    const truth = { commands: 0, failures: 0, files: new Set() };
    const seen = new Set();
    for await (const { rec } of streamRecords([...ref.files].sort())) {
      const p = rec.payload ?? {};
      if (p.type !== 'item_completed') continue;
      const item = p.item ?? {};
      if (item.id && seen.has(item.id)) continue;
      if (item.id) seen.add(item.id);
      if (item.type === 'CommandExecution') {
        truth.commands++;
        if ((item.exit_code ?? 0) !== 0) truth.failures++;
      }
      if (item.type === 'FileChange') for (const fp of Object.keys(item.changes ?? {})) truth.files.add(fp);
    }
    return truth;
  },
};

function sampleOf(sessions) {
  const candidates = sessions.filter((s) => s.bytes <= maxBytes);
  // Spread across the whole history rather than only the most recent sessions.
  const step = Math.max(1, Math.floor(candidates.length / sampleSize));
  return candidates.filter((_, i) => i % step === 0).slice(0, sampleSize);
}

async function check(adapter, ref) {
  const packet = await adapter.condense(ref);
  const { markdown } = renderMarkdown(packet, { budgetTokens: 40000 });
  const truth = await GROUND_TRUTH[adapter.id](ref);
  const problems = [];

  if (packet.stats.commands !== truth.commands) problems.push(`commands ${packet.stats.commands} ≠ ${truth.commands}`);
  const failures = packet.ledger.errors.reduce((n, e) => n + e.occurrences, 0);
  if (failures !== truth.failures) problems.push(`failures ${failures} ≠ ${truth.failures}`);
  if (packet.stats.filesTouched !== truth.files.size) problems.push(`files ${packet.stats.filesTouched} ≠ ${truth.files.size}`);
  const ledger = new Set(packet.ledger.files.map((f) => f.path));
  const missing = [...truth.files].find((p) => !ledger.has(p));
  if (missing) problems.push(`missing file ${missing}`);
  if (!markdown.includes(ref.id)) problems.push('session id missing from Markdown');
  // The same request text recorded twice in a row means two copies of one message were kept.
  for (const t of packet.turns) {
    const blocks = String(t.ask ?? '').split('\n\n').map((s) => s.trim()).filter((s) => s.length > 20);
    if (blocks.some((s, i) => i > 0 && s === blocks[i - 1])) {
      problems.push(`turn ${t.n} repeats a request`);
      break;
    }
  }

  return { packet, markdown, problems };
}

let pass = 0;
let fail = 0;
const failures = [];

for (const adapter of ADAPTERS) {
  if (onlySource && adapter.id !== onlySource) continue;
  if (!GROUND_TRUTH[adapter.id]) {
    console.log(`\n  ${adapter.label}: no ground-truth counter defined — skipped`);
    continue;
  }
  const sample = sampleOf(listSessions({ source: adapter.id }));
  console.log(`\n  ${adapter.label}: verifying ${sample.length} sessions (≤ ${(maxBytes / 1e6).toFixed(0)}MB each)\n`);
  for (const ref of sample) {
    const label = String(ref.title ?? ref.id).slice(0, 42).padEnd(42);
    try {
      const { packet, markdown, problems } = await check(adapterFor(ref.source), ref);
      if (problems.length) {
        fail++;
        failures.push({ ref, problems });
        console.log(`  ✗ ${label} ${problems.join('; ')}`);
      } else {
        pass++;
        const kb = String(Math.round(markdown.length / 1024)).padStart(4);
        console.log(`  ✓ ${label} ${String(packet.stats.turns).padStart(4)} turns ${kb}KB`);
      }
    } catch (err) {
      fail++;
      failures.push({ ref, problems: [`CRASH ${err?.message ?? err}`] });
      console.log(`  ✗ ${label} CRASH ${err?.message ?? err}`);
    }
  }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
for (const f of failures) console.log(`  ${f.ref.source} ${f.ref.id}  ${f.problems.join('; ')}`);
process.exit(fail ? 1 : 0);
