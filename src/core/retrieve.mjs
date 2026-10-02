/**
 * Retrieval over original session files.
 *
 * Packets deliberately drop command output, tool payloads and older turns.
 * These functions stream the raw files again so any of that can be recovered
 * verbatim on demand. Adapters supply the format knowledge through:
 *   describe(rec)            -> { text, label, turnId } | null
 *   replayEntry(rec, limit)  -> { ts, label, text?, output?, stderr?, changes? } | null
 *   turnIdOf(rec)            -> string | null
 */
import { streamLines } from './jsonl.mjs';

function contextWindow(text, needle, radius) {
  const idx = text.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return text.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + needle.length + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

/** Search a session for a literal string or regex. Most recent matches are kept. */
export async function searchSession(adapter, ref, query, opts = {}) {
  const { limit = 20, radius = 400, regex = false, kind = null } = opts;
  const re = regex ? new RegExp(query, 'i') : null;
  const needle = String(query);
  const lowered = needle.toLowerCase();
  const results = [];
  let scanned = 0;

  for await (const { line, file } of streamLines(adapter.filesFor(ref))) {
    scanned++;
    // Cheap pre-filter on the raw line before paying for JSON.parse.
    if (!regex && !line.toLowerCase().includes(lowered)) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const d = adapter.describe(rec);
    if (!d?.text) continue;
    if (regex ? !re.test(d.text) : !d.text.toLowerCase().includes(lowered)) continue;
    if (kind && !d.label.toLowerCase().includes(kind.toLowerCase())) continue;
    results.push({
      ts: rec.timestamp ?? null,
      turnId: d.turnId ?? null,
      label: d.label,
      excerpt: contextWindow(d.text, regex ? (re.exec(d.text)?.[0] ?? needle) : needle, radius),
      file,
    });
  }
  return { total: results.length, scanned, matches: results.slice(-limit) };
}

/**
 * Replay one turn at full fidelity, including the output packets drop.
 * Turn numbers match the packet's numbering, so "turn 12" means the same turn
 * in both places.
 */
export async function replayTurn(adapter, ref, turnNumber, opts = {}) {
  const { maxOutputChars = 4000 } = opts;
  const packet = await adapter.condense(ref);
  const turn = packet.turns[turnNumber - 1];
  if (!turn) return { found: false, turnCount: packet.turns.length };

  const events = [];
  for await (const { line } of streamLines(adapter.filesFor(ref))) {
    if (!line.includes(turn.turnId)) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (adapter.turnIdOf(rec) !== turn.turnId) continue;
    const entry = adapter.replayEntry(rec, maxOutputChars);
    if (entry) events.push(entry);
  }
  return { found: true, turnNumber, turnId: turn.turnId, turnCount: packet.turns.length, events };
}
