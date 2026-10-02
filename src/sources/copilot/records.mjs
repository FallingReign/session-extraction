/**
 * Copilot record knowledge for retrieval. The reader is stateful: tool
 * completions only name their tool through the matching start event, and turn
 * membership comes from the Tracker.
 */
import { oneLine } from '../../core/text.mjs';
import { Tracker } from './tracker.mjs';
import { SHELL_TOOLS, EDIT_TOOLS, shellOutcome } from './tools.mjs';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));

function callLabel(call, complete) {
  if (!call) return 'tool result';
  const a = call.args ?? {};
  if (SHELL_TOOLS.has(call.name)) {
    const exit = complete ? shellOutcome(complete).exit : '…';
    return `command (exit ${exit}): ${oneLine(a.command, 120)}`;
  }
  if (EDIT_TOOLS.has(call.name) || call.name === 'create' || call.name === 'view') return `${call.name} ${a.path ?? ''}`;
  if (call.name === 'apply_patch') return 'apply_patch';
  if (call.name === 'task') return `sub-agent ${a.agent_type ?? ''}: ${oneLine(a.name ?? a.description, 100)}`;
  return `tool ${call.mcp ?? call.name}`;
}

function labelOf(rec, pos) {
  const x = rec.data ?? {};
  const tag = pos.sub ? ' [sub-agent]' : '';
  switch (rec.type) {
    case 'user.message':
      return x.source && x.source !== 'user' ? `message from ${x.source}` : 'user message';
    case 'assistant.message':
      return `assistant message${tag}`;
    case 'tool.execution_start':
    case 'tool.execution_complete':
      return callLabel(pos.call, rec.type === 'tool.execution_complete' ? x : null) + tag;
    case 'session.compaction_complete':
      return 'checkpoint summary (written by Copilot)';
    case 'session.task_complete':
      return 'final answer';
    default:
      return rec.type;
  }
}

function textOf(rec) {
  const x = rec.data ?? {};
  const bits = [];
  const push = (v) => {
    const s = str(v);
    if (s) bits.push(s);
  };
  push(x.content);
  push(x.reasoningText);
  push(x.arguments);
  push(x.result?.content);
  if (x.result?.detailedContent !== x.result?.content) push(x.result?.detailedContent);
  push(x.error?.message);
  push(x.summary);
  push(x.summaryContent);
  push(x.message);
  return bits.join('\n');
}

export function reader() {
  const tracker = new Tracker();
  return {
    describe(rec) {
      const pos = tracker.see(rec);
      if (rec.type === 'user.message' && String(rec.data?.source ?? '').startsWith('skill-')) return null;
      const text = textOf(rec);
      if (!text) return null;
      return { text, label: labelOf(rec, pos), turnId: pos.interaction };
    },

    turnOf(rec) {
      return tracker.see(rec).interaction;
    },

    replay(rec, max) {
      const pos = tracker.see(rec);
      const x = rec.data ?? {};
      const cap = (s) => str(s).slice(0, max);
      const entry = { ts: rec.timestamp, label: labelOf(rec, pos) };

      switch (rec.type) {
        case 'user.message':
          if (String(x.source ?? '').startsWith('skill-')) return { ...entry, label: `skill loaded: ${x.source.slice(6)}` };
          entry.text = str(x.content);
          return entry;
        case 'assistant.message':
          if (!x.content && !x.reasoningText) return null;
          entry.text = [x.reasoningText ? `(thinking) ${oneLine(x.reasoningText, 400)}` : '', str(x.content)].filter(Boolean).join('\n');
          return entry;
        case 'tool.execution_complete': {
          const call = pos.call;
          if (call && (EDIT_TOOLS.has(call.name) || call.name === 'create' || call.name === 'apply_patch')) {
            const a = call.args ?? {};
            entry.changes = [
              {
                path: a.path ?? '(patch)',
                type: call.name === 'create' ? 'add' : 'update',
                body: cap(call.name === 'create' ? a.file_text : call.name === 'apply_patch' ? call.args : `- ${str(a.old_str)}\n+ ${str(a.new_str)}`),
              },
            ];
          } else if (call && !SHELL_TOOLS.has(call.name)) {
            entry.text = cap(call.args).slice(0, 1500);
          }
          if (x.success === false) entry.stderr = cap(x.error?.message);
          entry.output = cap(x.result?.content);
          return entry;
        }
        case 'subagent.completed':
          return { ...entry, label: `sub-agent finished: ${x.agentDisplayName ?? x.agentName} (${x.totalToolCalls ?? '?'} tool calls)` };
        case 'session.compaction_complete':
          entry.text = cap(x.summaryContent);
          return entry;
        case 'session.task_complete':
          entry.text = str(x.summary);
          return entry;
        case 'abort':
        case 'session.error':
          entry.text = str(x.reason ?? x.message);
          return entry;
        default:
          return null;
      }
    },
  };
}
