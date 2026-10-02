/**
 * Retrieval over the original rollout files.
 *
 * The handoff packet deliberately discards command output, tool payloads and
 * older detail. This module streams the raw transcript again to pull that
 * detail back on demand, so condensation costs nothing permanently: the packet
 * orients the agent, and these queries recover anything it needs verbatim.
 */
import fs from 'node:fs';
import readline from 'node:readline';

const oneLine = (s, n = 160) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n) + '…';
};

/** Every text field worth searching, flattened out of a record. */
function textOf(rec) {
  const p = rec.payload ?? {};
  const item = p.item ?? {};
  const bits = [];
  const push = (v) => {
    if (typeof v === 'string' && v) bits.push(v);
  };

  push(p.last_agent_message);
  for (const c of p.content ?? []) push(c?.text);
  for (const c of item.content ?? []) push(c?.text);
  push(item.query);
  push(item.text);
  push(item.stdout);
  push(item.stderr);
  push(item.aggregated_output);
  push(item.formatted_output);
  push(p.input);
  push(p.arguments);
  push(typeof p.output === 'string' ? p.output : null);
  for (const c of Array.isArray(p.output) ? p.output : []) push(c?.text);
  if (Array.isArray(item.parsed_cmd)) for (const c of item.parsed_cmd) push(c?.cmd);
  if (Array.isArray(item.command)) push(item.command.join(' '));
  if (item.changes) for (const [k, v] of Object.entries(item.changes)) {
    push(k);
    push(v?.content);
    push(v?.unified_diff ?? v?.diff);
  }
  if (item.arguments) push(JSON.stringify(item.arguments));
  if (item.result) push(JSON.stringify(item.result).slice(0, 20000));
  for (const s of item.summary_text ?? []) push(typeof s === 'string' ? s : s?.text);

  return bits.join('\n');
}

/** A short human label describing what kind of record this is. */
function labelOf(rec) {
  const p = rec.payload ?? {};
  const item = p.item ?? {};
  if (rec.type === 'response_item' && p.type === 'message') return `${p.role} message`;
  if (p.type === 'task_complete') return 'final answer';
  if (item.type === 'CommandExecution') {
    const cmd = (item.parsed_cmd ?? []).map((c) => c?.cmd).filter(Boolean).join(' ; ') ||
      (Array.isArray(item.command) ? item.command.join(' ') : '');
    return `command (exit ${item.exit_code ?? 0}): ${oneLine(cmd, 120)}`;
  }
  if (item.type === 'FileChange') return `file change: ${Object.keys(item.changes ?? {}).join(', ')}`;
  if (item.type === 'McpToolCall') return `tool ${item.server}.${item.tool}`;
  if (item.type) return item.type;
  return p.type ?? rec.type;
}

function contextWindow(text, needle, radius) {
  const hay = text.toLowerCase();
  const idx = hay.indexOf(needle.toLowerCase());
  if (idx === -1) return text.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + needle.length + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

/**
 * Search a thread's rollout for a literal string or regex.
 * Returns matches with surrounding context, newest last.
 */
export async function searchThread(thread, query, opts = {}) {
  const { limit = 20, radius = 400, regex = false, kind = null } = opts;
  const re = regex ? new RegExp(query, 'i') : null;
  const needle = String(query);
  const lowered = needle.toLowerCase();
  const results = [];
  let scanned = 0;

  for (const file of [...thread.files].sort()) {
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      scanned++;
      // Cheap pre-filter on the raw line before paying for JSON.parse.
      if (!regex && !line.toLowerCase().includes(lowered)) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const text = textOf(rec);
      if (!text) continue;
      if (regex ? !re.test(text) : !text.toLowerCase().includes(lowered)) continue;
      const label = labelOf(rec);
      if (kind && !label.toLowerCase().includes(kind.toLowerCase())) continue;
      results.push({
        ts: rec.timestamp,
        turnId: rec.payload?.turn_id ?? rec.payload?.internal_chat_message_metadata_passthrough?.turn_id ?? null,
        label,
        excerpt: contextWindow(text, regex ? (re.exec(text)?.[0] ?? needle) : needle, radius),
        file,
      });
    }
    rl.close();
  }
  // Most recent matches are usually the relevant ones.
  const tail = results.slice(-limit);
  return { total: results.length, scanned, matches: tail };
}

/**
 * Replay one turn at full fidelity, including the command output the packet drops.
 */
export async function replayTurn(thread, turnNumber, opts = {}) {
  const { maxOutputChars = 4000 } = opts;
  const turnIds = [];
  const seen = new Set();
  const events = [];

  // First pass: establish turn ordering exactly as the condenser does.
  for (const file of [...thread.files].sort()) {
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const p = rec.payload ?? {};
      const tid = p.turn_id ?? p.internal_chat_message_metadata_passthrough?.turn_id ?? null;
      if (tid && !seen.has(tid)) {
        seen.add(tid);
        turnIds.push(tid);
      }
    }
    rl.close();
  }

  const wanted = turnIds[turnNumber - 1];
  if (!wanted) return { found: false, turnCount: turnIds.length };

  for (const file of [...thread.files].sort()) {
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.includes(wanted)) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const p = rec.payload ?? {};
      const tid = p.turn_id ?? p.internal_chat_message_metadata_passthrough?.turn_id ?? null;
      if (tid !== wanted) continue;
      if (rec.type === 'response_item') continue; // twin of the event_msg form
      if (p.type === 'token_count') continue;
      const item = p.item ?? {};
      const entry = { ts: rec.timestamp, label: labelOf(rec) };
      if (item.type === 'CommandExecution') {
        entry.output = String(item.formatted_output || item.aggregated_output || item.stdout || '').slice(
          0,
          maxOutputChars
        );
        entry.stderr = String(item.stderr ?? '').slice(0, maxOutputChars);
        entry.exit = item.exit_code ?? 0;
      } else if (item.type === 'FileChange') {
        entry.changes = Object.entries(item.changes ?? {}).map(([k, v]) => ({
          path: k,
          type: v?.type,
          body: String(v?.content ?? v?.unified_diff ?? v?.diff ?? '').slice(0, maxOutputChars),
        }));
      } else if (item.type === 'AgentMessage' || item.type === 'UserMessage') {
        entry.text = (item.content ?? []).map((c) => c.text ?? '').join('\n');
      } else if (p.type === 'task_complete') {
        entry.text = p.last_agent_message ?? '';
      } else if (item.type === 'McpToolCall') {
        entry.text = JSON.stringify(item.arguments ?? {}).slice(0, 1500);
        entry.output = JSON.stringify(item.result ?? {}).slice(0, maxOutputChars);
      } else {
        continue;
      }
      events.push(entry);
    }
    rl.close();
  }

  return { found: true, turnNumber, turnId: wanted, turnCount: turnIds.length, events };
}
