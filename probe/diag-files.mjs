// Diagnose a file-count mismatch: symmetric difference between packet files and an
// independent recount using the verify harness rules.
import path from 'node:path';
import { openSession } from '../src/core/sources.mjs';
import { streamRecords } from '../src/core/jsonl.mjs';

const { adapter, ref } = await openSession(process.argv[2]);
const packet = await adapter.condense(ref);
const fromPacket = new Set(packet.ledger.files.map((f) => f.path));

const truth = new Set();
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
  if (!s || d.success === false) continue;
  if (/^(edit|str_replace|str-replace|create)$/.test(s.toolName) && s.arguments?.path) truth.add(abs(s.arguments.path));
  if (s.toolName === 'apply_patch') {
    const patch = typeof s.arguments === 'string' ? s.arguments : (s.arguments?.input ?? '');
    for (const m of patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|(Move to)): (.+?)\s*$/gm)) {
      truth.add(abs(m[2]));
      if (m[1]) console.log('MOVE in patch:', m[0]);
    }
  }
}
for (const p of fromPacket) if (!truth.has(p)) console.log('packet only:', JSON.stringify(p));
for (const p of truth) if (!fromPacket.has(p)) console.log('truth only :', JSON.stringify(p));
