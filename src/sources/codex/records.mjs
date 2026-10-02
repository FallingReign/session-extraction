/**
 * Codex record knowledge for retrieval: what text a record carries, how to
 * label it, which turn it belongs to, and how to show it in a turn replay.
 */
import { oneLine } from '../../core/text.mjs';
import { commandOf } from './condense.mjs';

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
  if (item.changes) {
    for (const [k, v] of Object.entries(item.changes)) {
      push(k);
      push(v?.content);
      push(v?.unified_diff ?? v?.diff);
    }
  }
  if (item.arguments) push(JSON.stringify(item.arguments));
  if (item.result) push(JSON.stringify(item.result).slice(0, 20000));
  for (const s of item.summary_text ?? []) push(typeof s === 'string' ? s : s?.text);

  return bits.join('\n');
}

function labelOf(rec) {
  const p = rec.payload ?? {};
  const item = p.item ?? {};
  if (rec.type === 'response_item' && p.type === 'message') return `${p.role} message`;
  if (p.type === 'task_complete') return 'final answer';
  if (item.type === 'CommandExecution') return `command (exit ${item.exit_code ?? 0}): ${oneLine(commandOf(item), 120)}`;
  if (item.type === 'FileChange') return `file change: ${Object.keys(item.changes ?? {}).join(', ')}`;
  if (item.type === 'McpToolCall') return `tool ${item.server}.${item.tool}`;
  if (item.type) return item.type;
  return p.type ?? rec.type;
}

export function turnIdOf(rec) {
  const p = rec.payload ?? {};
  return p.turn_id ?? p.internal_chat_message_metadata_passthrough?.turn_id ?? null;
}

export function describe(rec) {
  const text = textOf(rec);
  if (!text) return null;
  return { text, label: labelOf(rec), turnId: turnIdOf(rec) };
}

export function replayEntry(rec, maxOutputChars) {
  // response_item records are twins of the richer event_msg form.
  if (rec.type === 'response_item') return null;
  const p = rec.payload ?? {};
  if (p.type === 'token_count') return null;
  const item = p.item ?? {};
  const entry = { ts: rec.timestamp, label: labelOf(rec) };
  const cap = (s) => String(s ?? '').slice(0, maxOutputChars);

  if (item.type === 'CommandExecution') {
    entry.output = cap(item.formatted_output || item.aggregated_output || item.stdout);
    entry.stderr = cap(item.stderr);
    entry.exit = item.exit_code ?? 0;
  } else if (item.type === 'FileChange') {
    entry.changes = Object.entries(item.changes ?? {}).map(([k, v]) => ({
      path: k,
      type: v?.type,
      body: cap(v?.content ?? v?.unified_diff ?? v?.diff),
    }));
  } else if (item.type === 'AgentMessage' || item.type === 'UserMessage') {
    entry.text = (item.content ?? []).map((c) => c.text ?? '').join('\n');
  } else if (p.type === 'task_complete') {
    entry.text = p.last_agent_message ?? '';
  } else if (item.type === 'McpToolCall') {
    entry.text = JSON.stringify(item.arguments ?? {}).slice(0, 1500);
    entry.output = cap(JSON.stringify(item.result ?? {}));
  } else {
    return null;
  }
  return entry;
}
