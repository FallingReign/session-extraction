/**
 * Codex rollout → packet.
 *
 * Translates Codex records into PacketBuilder calls. Format knowledge only;
 * all bookkeeping lives in core/packet-builder.mjs.
 *
 * Reduction rules specific to Codex:
 *  - response_item and event_msg|item_completed are twins of the same item;
 *    the event_msg form is richer, so it wins and the twin is ignored.
 *  - reasoning.encrypted_content is ciphertext and is dropped; summaries kept.
 *  - user messages are stripped of system envelopes (AGENTS.md, environment
 *    context, plugin lists), guardian/safety-review prompts that replay the
 *    transcript, and in-app browser state blocks.
 */
import { PacketBuilder } from '../../core/packet-builder.mjs';
import { streamRecords } from '../../core/jsonl.mjs';
import { oneLine, countLines, diffLines } from '../../core/text.mjs';

const ENVELOPE_KINDS = new Set([
  'plugins.recommendations',
  'agents_md.instructions',
  'environments.environment_context',
  'memories.instructions',
  'generic.developer_instructions',
  'multi_agent.role_instructions',
  'apps.instructions',
  'skills.instructions',
]);

const ENVELOPE_HEADS = [
  '<recommended_plugins>',
  '<environment_context>',
  '# AGENTS.md instructions',
  '<app-context>',
  '<user_instructions>',
  '<multi_agent_role>',
  '## Memory',
  '# Collaboration Mode',
];

const GUARDIAN_MARKERS = [
  'whose request action you are assessing',
  '>>> TRANSCRIPT START',
  'You are a security reviewer',
];

const AMBIENT_BLOCK = /<in-app-browser-context[\s\S]*?<\/in-app-browser-context>/g;
const REQUEST_MARKER = /^##\s*My request:\s*/im;
const DELEGATION_NAMES = new Set(['create_thread', 'send_message_to_thread']);

/** Pull the human's actual words out of a user message payload. */
export function extractUserText(payload) {
  const kinds = payload?.internal_chat_message_metadata_passthrough?.content_item_kinds ?? null;
  const kept = [];
  (payload?.content ?? []).forEach((part, i) => {
    const text = part?.text ?? '';
    if (!text.trim()) return;
    const kind = Array.isArray(kinds) ? kinds[i] : null;
    if (kind && ENVELOPE_KINDS.has(kind)) return;
    if (!kind && ENVELOPE_HEADS.some((h) => text.trimStart().startsWith(h))) return;
    kept.push(text);
  });
  let text = kept.join('\n\n');
  if (!text.trim()) return null;
  if (GUARDIAN_MARKERS.some((m) => text.includes(m))) return null;
  text = text.replace(AMBIENT_BLOCK, '').trim();
  if (REQUEST_MARKER.test(text)) text = text.split(REQUEST_MARKER).pop().trim();
  if (!text || text.length < 2) return null;
  return text;
}

export function commandOf(item) {
  const parsed = Array.isArray(item?.parsed_cmd) ? item.parsed_cmd : [];
  const fromParsed = parsed.map((p) => p?.cmd).filter(Boolean).join(' ; ');
  if (fromParsed) return fromParsed;
  if (Array.isArray(item?.command)) return item.command.join(' ');
  return item?.command ?? '(unknown command)';
}

function durationMs(d) {
  if (!d) return null;
  if (typeof d === 'number') return d;
  return Math.round((d.secs ?? 0) * 1000 + (d.nanos ?? 0) / 1e6);
}

const PLAN_RE = /update_plan\(\s*(\{[\s\S]*?\})\s*\)/g;
const STEP_RE = /step\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*,\s*status\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
const unquote = (s) => JSON.parse(s.replace(/^'|'$/g, '"'));

/** Plans are set via update_plan() calls embedded in exec scripts; keep the last. */
function extractPlan(input) {
  if (typeof input !== 'string' || !input.includes('update_plan')) return null;
  let last = null;
  for (const m of input.matchAll(PLAN_RE)) {
    const steps = [...m[1].matchAll(STEP_RE)].map((s) => ({ step: unquote(s[1]), status: unquote(s[2]) }));
    if (steps.length) last = steps;
  }
  return last;
}

function fileVerb(change) {
  const t = change?.type ?? 'update';
  if (t === 'add') return 'add';
  if (t === 'delete' || t === 'remove') return 'delete';
  return 'update';
}

function fileLines(change) {
  if (typeof change?.content === 'string') return countLines(change.content);
  return diffLines(change?.unified_diff ?? change?.diff);
}

const turnOfResponse = (p) => p?.internal_chat_message_metadata_passthrough?.turn_id;

/**
 * Newer Codex versions record each user message twice: as a response_item and
 * as an event_msg UserMessage. Older ones record only the response_item. Pair
 * them by arrival order within a turn so each message is kept exactly once.
 */
class UserMessageTwins {
  constructor() {
    this.counts = new Map();
  }

  /** True when this message is the second copy of one already kept. */
  isTwin(turnId, form) {
    const c = this.counts.get(turnId) ?? { response: 0, event: 0 };
    this.counts.set(turnId, c);
    c[form]++;
    const other = form === 'response' ? c.event : c.response;
    return c[form] <= other;
  }
}

export async function condense(ref, limits = {}) {
  const b = new PacketBuilder(limits);
  const seenItemIds = new Set();
  const twins = new UserMessageTwins();
  let meta = null;
  const files = [...ref.files].sort();

  for await (const { rec } of streamRecords(files, { onParseFailure: () => b.parseFailures++ })) {
    b.records++;
    const p = rec.payload ?? {};
    const ts = rec.timestamp ?? null;

    switch (rec.type) {
      case 'session_meta':
        if (!meta) meta = p;
        b.contextWindow = b.contextWindow ?? p?.context_window ?? null;
        break;
      case 'world_state': {
        const t = p?.state?.agents_md?.text;
        if (t && !b.instructions) b.instructions = t;
        break;
      }
      case 'compacted':
        b.compaction(
          b.turn(turnOfResponse(p?.replacement_history?.[0]), ts),
          'context compacted — earlier history replaced by a summary',
          ts
        );
        break;
      case 'token_usage_record':
        b.lastTokenRecord = p?.thread_token_usage ?? p?.usage ?? b.lastTokenRecord;
        break;
      case 'response_item':
        handleResponseItem(b, p, ts, twins);
        break;
      case 'event_msg':
        handleEvent(b, p, ts, seenItemIds, twins);
        break;
      default:
        break;
    }
  }

  return b.finish({
    source: 'codex',
    id: ref.id,
    title: ref.title,
    link: ref.link,
    cwd: meta?.cwd ?? ref.cwd,
    model: ref.model ?? meta?.base_instructions?.provenance?.model ?? null,
    originator: meta?.originator ?? ref.originator ?? null,
    clientVersion: meta?.cli_version ?? null,
    startedAt: ref.startedAt,
    updatedAt: ref.updatedAt,
    bytes: ref.bytes,
    segmentCount: files.length,
    files,
  });
}

function handleResponseItem(b, p, ts, twins) {
  if (p.type === 'message' && p.role === 'user') {
    const text = extractUserText(p);
    const turnId = turnOfResponse(p);
    if (text && !twins.isTwin(turnId, 'response')) b.ask(b.turn(turnId, ts), text, 'user');
    return;
  }
  if (p.type === 'function_call_output' && DELEGATION_NAMES.has(p.name)) {
    const t = b.turn(turnOfResponse(p), ts);
    const input = /<input>([\s\S]*?)<\/input>/.exec(p.output ?? '')?.[1]?.trim();
    if (input) b.ask(t, input, p.name === 'create_thread' ? 'delegated-in' : 'delegated-message', 'if-empty');
    b.delegation({ kind: p.name, ts, summary: oneLine(input ?? p.output, 160) });
    return;
  }
  if (p.type === 'custom_tool_call' || p.type === 'function_call') {
    const found = extractPlan(p.input ?? p.arguments ?? '');
    if (found) b.plan = found;
  }
  // Reasoning and assistant messages are covered by their event_msg twins.
}

function handleEvent(b, p, ts, seenItemIds, twins) {
  if (p.type === 'task_started') {
    b.turn(p.turn_id, ts);
    return;
  }
  if (p.type === 'task_complete') {
    const t = b.turn(p.turn_id, ts);
    b.final(t, p.last_agent_message);
    if (p.duration_ms) t.durationMs = p.duration_ms;
    return;
  }
  if (p.type === 'token_count') {
    const tot = p?.info?.total_token_usage?.total_tokens;
    if (typeof tot === 'number') b.totalTokens = Math.max(b.totalTokens, tot);
    return;
  }
  if (p.type !== 'item_completed') return;

  const item = p.item ?? {};
  if (item.id && seenItemIds.has(item.id)) return;
  if (item.id) seenItemIds.add(item.id);
  const t = b.turn(p.turn_id, ts);

  switch (item.type) {
    case 'AgentMessage': {
      const text = (item.content ?? []).map((c) => c.text ?? '').join('\n').trim();
      if (!text) break;
      if (item.phase === 'commentary') b.note(t, text);
      else b.final(t, text);
      break;
    }
    case 'Reasoning':
      b.reasoning(t, (item.summary_text ?? []).map((s) => (typeof s === 'string' ? s : s?.text ?? '')));
      break;
    case 'CommandExecution': {
      const exit = item.exit_code ?? 0;
      const errorText =
        exit === 0 ? '' : (item.stderr || '').trim() || (item.aggregated_output || item.stdout || '').trim();
      b.command(t, { cmd: commandOf(item), exit, ms: durationMs(item.duration), errorText, ts });
      break;
    }
    case 'FileChange':
      for (const [fp, change] of Object.entries(item.changes ?? {})) {
        b.fileChange(t, { path: fp, verb: fileVerb(change), lines: fileLines(change), ts });
      }
      break;
    case 'McpToolCall':
      b.tool(t, {
        name: `${item.server}.${item.tool}`,
        label: item.arguments?.title ?? item.arguments?.code ?? item.arguments?.query ?? '',
        failed: item.result?.isError === true,
        ms: durationMs(item.duration),
        ts,
      });
      break;
    case 'UserMessage': {
      const text = (item.content ?? []).map((c) => c.text ?? '').join('\n').trim();
      const cleaned = text ? extractUserText({ content: [{ text }] }) : null;
      if (cleaned && !twins.isTwin(p.turn_id, 'event')) b.ask(t, cleaned, 'user', 'append-keep-source');
      break;
    }
    case 'WebSearch':
    case 'Extension':
      if (item.type === 'WebSearch' || item.kind === 'web.search' || item.action?.type === 'search') {
        b.search(t, item.query ?? item.action?.query ?? '', ts);
      } else {
        b.action(t, { kind: 'ext', line: `${item.kind ?? 'extension'}`, ts });
      }
      break;
    case 'ImageView':
      b.action(t, { kind: 'image', line: `viewed image ${oneLine(item.path, 160)}`, ts });
      break;
    case 'SubAgentActivity':
      b.delegation({ kind: item.kind ?? 'sub-agent', ts, summary: item.agent_path ?? '' });
      b.action(t, {
        kind: 'delegate',
        line: `sub-agent ${item.kind ?? 'activity'} ${item.agent_path ?? ''} (thread ${String(item.agent_thread_id ?? '').slice(0, 8)})`,
        ts,
      });
      break;
    case 'CollabAgentToolCall': {
      const to = (item.receiver_agents ?? []).join(', ') || (item.receiver_thread_ids ?? []).length + ' agent(s)';
      b.action(t, { kind: 'delegate', line: `agent coordination: ${item.tool}${to ? ` → ${to}` : ''}`, ts });
      break;
    }
    case 'Plan':
      if (item.text) b.planDoc = item.text;
      break;
    case 'FunctionCallOutput':
      if (DELEGATION_NAMES.has(item.name)) {
        b.action(t, { kind: 'delegate', line: `${item.name} → sub-agent thread`, ts });
      }
      break;
    case 'ContextCompaction':
      b.compaction(t, 'context compacted', ts);
      break;
    case 'TodoList':
    case 'PlanUpdate': {
      const steps = (item.items ?? item.plan ?? []).map((s) => ({
        step: s.step ?? s.text ?? String(s),
        status: s.status ?? (s.completed ? 'completed' : 'pending'),
      }));
      if (steps.length) b.plan = steps;
      break;
    }
    default:
      break;
  }
}
