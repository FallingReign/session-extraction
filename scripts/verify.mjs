#!/usr/bin/env node
/**
 * Fidelity + robustness harness.
 *
 * Robustness: condense many sessions and assert none crash.
 * Fidelity:   independently recount the things that must never be lost
 *             (user asks, file changes, commands, failures) straight from the
 *             rollout, and compare against what the packet reports.
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { loadIndex } from '../src/lib/index-store.mjs';
import { condenseThread } from '../src/lib/condense.mjs';
import { renderMarkdown } from '../src/lib/render-markdown.mjs';

const args = process.argv.slice(2);
const maxBytes = Number(args.find((a) => a.startsWith('--max-bytes='))?.split('=')[1] ?? 30e6);
const sampleSize = Number(args.find((a) => a.startsWith('--sample='))?.split('=')[1] ?? 40);

/** Ground truth, counted directly off the raw records. */
async function groundTruth(thread) {
  const truth = { fileChanges: 0, filePaths: new Set(), commands: 0, failures: 0, finals: 0 };
  for (const file of [...thread.files].sort()) {
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    const seen = new Set();
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const p = rec.payload ?? {};
      if (p.type === 'task_complete' && p.last_agent_message) truth.finals++;
      if (p.type !== 'item_completed') continue;
      const item = p.item ?? {};
      if (item.id && seen.has(item.id)) continue;
      if (item.id) seen.add(item.id);
      if (item.type === 'CommandExecution') {
        truth.commands++;
        if ((item.exit_code ?? 0) !== 0) truth.failures++;
      }
      if (item.type === 'FileChange') {
        for (const fp of Object.keys(item.changes ?? {})) {
          truth.fileChanges++;
          truth.filePaths.add(fp);
        }
      }
    }
    rl.close();
  }
  return truth;
}

const index = loadIndex();
const candidates = index.threads.filter((t) => t.bytes <= maxBytes);
// Spread the sample across the size range rather than taking only recent ones.
const step = Math.max(1, Math.floor(candidates.length / sampleSize));
const sample = candidates.filter((_, i) => i % step === 0).slice(0, sampleSize);

let pass = 0;
let fail = 0;
const problems = [];

console.log(`\n  Verifying ${sample.length} sessions (≤ ${(maxBytes / 1e6).toFixed(0)}MB each)\n`);

for (const thread of sample) {
  const label = `${(thread.title ?? thread.threadId).slice(0, 42).padEnd(42)}`;
  try {
    const packet = await condenseThread(thread);
    const { markdown } = renderMarkdown(packet, { budgetTokens: 40000 });
    const truth = await groundTruth(thread);

    const checks = [];
    if (packet.stats.commands !== truth.commands) {
      checks.push(`commands ${packet.stats.commands} ≠ ${truth.commands}`);
    }
    if (packet.stats.filesTouched !== truth.filePaths.size) {
      checks.push(`files ${packet.stats.filesTouched} ≠ ${truth.filePaths.size}`);
    }
    const packetFailures = packet.ledger.errors.reduce((n, e) => n + e.occurrences, 0);
    if (packetFailures !== truth.failures) {
      checks.push(`failures ${packetFailures} ≠ ${truth.failures}`);
    }
    // Every file the session touched must appear in the ledger.
    const ledgerPaths = new Set(packet.ledger.files.map((f) => f.path));
    for (const p of truth.filePaths) {
      if (!ledgerPaths.has(p)) {
        checks.push(`missing file ${p}`);
        break;
      }
    }
    // Markdown must always carry orientation.
    if (!markdown.includes('## Where things stand')) checks.push('missing orientation section');
    if (!markdown.includes(thread.threadId)) checks.push('missing thread id');

    if (checks.length) {
      fail++;
      problems.push({ thread, checks });
      console.log(`  ✗ ${label} ${checks.join('; ')}`);
    } else {
      pass++;
      const ratio = thread.bytes / Math.max(1, markdown.length);
      console.log(
        `  ✓ ${label} ${String(packet.stats.turns).padStart(4)} turns  ${String(Math.round(markdown.length / 1024)).padStart(4)}KB  ${ratio.toFixed(0)}×`
      );
    }
  } catch (err) {
    fail++;
    problems.push({ thread, checks: [String(err?.message ?? err)] });
    console.log(`  ✗ ${label} CRASH: ${err?.message ?? err}`);
  }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fail) {
  for (const p of problems) console.log(`  ${p.thread.threadId}  ${p.checks.join('; ')}`);
  process.exit(1);
}
