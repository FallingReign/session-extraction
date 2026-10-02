/**
 * Deterministic Codex rollout condenser.
 *
 * Streams a thread's rollout segments once, in order, and reduces them to a
 * compact packet. No model involvement: every decision here is a rule.
 *
 * Reduction strategy:
 *  - response_item and event_msg|item_completed are twins describing the same
 *    item; the event_msg form is richer, so it wins and the twin is discarded.
 *  - reasoning.encrypted_content is unreadable ciphertext and is dropped;
 *    summary_text is kept when present.
 *  - command stdout/stderr is dropped except for failures and short outputs.
 *  - file change bodies are dropped; only path + verb + size delta survive.
 *  - repeated identical commands collapse into a single line with a count.
 */
import fs from 'node:fs';
import readline from 'node:readline';

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

const clip = (s, n) => {
  if (!s) return '';
  const t = String(s).replace(/\s+$/, '');
  return t.length <= n ? t : t.slice(0, n) + ` …[+${t.length - n} chars]`;
};

/** Failures explain themselves at the END of their output, not the start. */
const clipTail = (s, n) => {
  if (!s) return '';
  const t = String(s).replace(/\s+$/, '');
  return t.length <= n ? t : `…[${t.length - n} earlier chars omitted]\n` + t.slice(-n);
};

/** Normalised form used to tell whether two runs are "the same command". */
const cmdKey = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();

const oneLine = (s, n = 200) => clip(String(s ?? '').replace(/\s+/g, ' ').trim(), n);

/** Pull the human's actual words out of a user message record. */
function extractUserText(payload) {
  const kinds = payload?.internal_chat_message_metadata_passthrough?.content_item_kinds ?? null;
  const parts = payload?.content ?? [];
  const kept = [];
  parts.forEach((part, i) => {
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
  // A message that was only ambient state has nothing left worth keeping.
  if (!text || text.length < 2) return null;
  return text;
}

function commandOf(item) {
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

function extractPlan(input) {
  if (typeof input !== 'string' || !input.includes('update_plan')) return null;
  let last = null;
  for (const m of input.matchAll(PLAN_RE)) {
    const steps = [...m[1].matchAll(/step\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*,\s*status\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g)].map(
      (s) => ({ step: JSON.parse(s[1].replace(/^'|'$/g, '"')), status: JSON.parse(s[2].replace(/^'|'$/g, '"')) })
    );
    if (steps.length) last = steps;
  }
  return last;
}

class Ledger {
  constructor() {
    this.files = new Map();
    this.commands = new Map();
    this.errors = [];
    this.successes = new Set();
    this.mcp = new Map();
    this.searches = [];
    this.delegations = [];
  }

  file(p, verb, lines, ts) {
    const key = p;
    const e = this.files.get(key) ?? { path: p, add: 0, update: 0, delete: 0, lines: 0, firstTs: ts, lastTs: ts };
    e[verb] = (e[verb] ?? 0) + 1;
    e.lines += lines ?? 0;
    e.lastTs = ts;
    this.files.set(key, e);
  }

  command(cmd, ok) {
    const e = this.commands.get(cmd) ?? { cmd, runs: 0, failures: 0 };
    e.runs++;
    if (!ok) e.failures++;
    this.commands.set(cmd, e);
  }

  tool(server, tool) {
    const key = `${server}.${tool}`;
    this.mcp.set(key, (this.mcp.get(key) ?? 0) + 1);
  }
}

function countLines(s) {
  if (typeof s !== 'string') return 0;
  return s ? s.split('\n').length : 0;
}

function fileVerb(change) {
  const t = change?.type ?? 'update';
  if (t === 'add') return 'add';
  if (t === 'delete' || t === 'remove') return 'delete';
  return 'update';
}

function fileLines(change) {
  if (typeof change?.content === 'string') return countLines(change.content);
  const diff = change?.unified_diff ?? change?.diff;
  if (typeof diff === 'string') return diff.split('\n').filter((l) => /^[+-][^+-]/.test(l)).length;
  return 0;
}

export async function condenseThread(thread, opts = {}) {
  const {
    maxUserChars = 4000,
    maxFinalChars = 3000,
    maxNoteChars = 220,
    keepReasoning = true,
    keepErrorOutput = 1200,
  } = opts;

  const ledger = new Ledger();
  const turns = [];
  const seenItemIds = new Set();
  let meta = null;
  let agentsMd = null;
  let plan = null;
  let planDoc = null;
  let compactions = 0;
  let totalTokens = 0;
  let lastTokenRecord = null;
  let contextWindow = null;
  let parseFailures = 0;
  let lineCount = 0;

  const turnIndex = new Map();
  const ensureTurn = (turnId, ts) => {
    if (!turnId) turnId = `orphan-${turns.length}`;
    let t = turnIndex.get(turnId);
    if (!t) {
      t = {
        n: turns.length + 1,
        turnId,
        startedAt: ts,
        endedAt: ts,
        ask: null,
        askSource: null,
        notes: [],
        reasoning: [],
        actions: [],
        final: null,
        durationMs: null,
      };
      turnIndex.set(turnId, t);
      turns.push(t);
    }
    if (ts) t.endedAt = ts;
    return t;
  };

  // Segments oldest-first so the timeline reads forwards.
  const segments = [...thread.files].sort();

  for (const file of segments) {
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      lineCount++;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        parseFailures++;
        continue;
      }
      const p = rec.payload ?? {};
      const ts = rec.timestamp ?? null;

      if (rec.type === 'session_meta') {
        if (!meta) meta = p;
        contextWindow = contextWindow ?? p?.context_window ?? null;
        continue;
      }

      if (rec.type === 'world_state') {
        const t = p?.state?.agents_md?.text;
        if (t && !agentsMd) agentsMd = t;
        continue;
      }

      if (rec.type === 'compacted') {
        compactions++;
        const t = ensureTurn(p?.replacement_history?.[0]?.internal_chat_message_metadata_passthrough?.turn_id, ts);
        t.actions.push({ kind: 'compaction', line: 'context compacted — earlier history replaced by a summary', ts });
        continue;
      }

      if (rec.type === 'token_usage_record') {
        lastTokenRecord = p?.thread_token_usage ?? p?.usage ?? lastTokenRecord;
        continue;
      }

      if (rec.type === 'turn_context') continue;

      if (rec.type === 'response_item') {
        if (p.type === 'message' && p.role === 'user') {
          const text = extractUserText(p);
          if (text) {
            const t = ensureTurn(p?.internal_chat_message_metadata_passthrough?.turn_id, ts);
            t.ask = t.ask ? `${t.ask}\n\n${clip(text, maxUserChars)}` : clip(text, maxUserChars);
            t.askSource = 'user';
          }
          continue;
        }
        if (p.type === 'function_call_output' && (p.name === 'create_thread' || p.name === 'send_message_to_thread')) {
          const t = ensureTurn(p?.internal_chat_message_metadata_passthrough?.turn_id, ts);
          const input = /<input>([\s\S]*?)<\/input>/.exec(p.output ?? '')?.[1]?.trim();
          if (input && !t.ask) {
            t.ask = clip(input, maxUserChars);
            t.askSource = p.name === 'create_thread' ? 'delegated-in' : 'delegated-message';
          }
          ledger.delegations.push({ kind: p.name, ts, summary: oneLine(input ?? p.output, 160) });
          continue;
        }
        if (p.type === 'custom_tool_call' || p.type === 'function_call') {
          const found = extractPlan(p.input ?? p.arguments ?? '');
          if (found) plan = found;
          continue;
        }
        continue; // reasoning + assistant twins are covered by event_msg
      }

      if (rec.type !== 'event_msg') continue;

      if (p.type === 'task_started') {
        ensureTurn(p.turn_id, ts);
        continue;
      }

      if (p.type === 'task_complete') {
        const t = ensureTurn(p.turn_id, ts);
        if (p.last_agent_message) t.final = clip(p.last_agent_message, maxFinalChars);
        if (p.duration_ms) t.durationMs = p.duration_ms;
        continue;
      }

      if (p.type === 'token_count') {
        const tot = p?.info?.total_token_usage?.total_tokens;
        if (typeof tot === 'number') totalTokens = Math.max(totalTokens, tot);
        continue;
      }

      if (p.type !== 'item_completed') continue;

      const item = p.item ?? {};
      if (item.id && seenItemIds.has(item.id)) continue;
      if (item.id) seenItemIds.add(item.id);
      const t = ensureTurn(p.turn_id, ts);

      switch (item.type) {
        case 'AgentMessage': {
          const text = (item.content ?? []).map((c) => c.text ?? '').join('\n').trim();
          if (!text) break;
          if (item.phase === 'commentary') t.notes.push(oneLine(text, maxNoteChars));
          else t.final = clip(text, maxFinalChars);
          break;
        }
        case 'Reasoning': {
          if (!keepReasoning) break;
          const sum = (item.summary_text ?? [])
            .map((s) => (typeof s === 'string' ? s : s?.text ?? ''))
            .filter(Boolean)
            .map((s) => s.replace(/\*\*/g, '').trim());
          if (sum.length) t.reasoning.push(...sum);
          break;
        }
        case 'CommandExecution': {
          const cmd = commandOf(item);
          const ok = (item.exit_code ?? 0) === 0;
          ledger.command(cmd, ok);
          const ms = durationMs(item.duration);
          const action = { kind: 'exec', line: oneLine(cmd, 240), exit: item.exit_code ?? 0, ms, ts };
          if (!ok) {
            // Prefer stderr; fall back to the tail of combined output.
            const raw = (item.stderr || '').trim() || (item.aggregated_output || item.stdout || '').trim();
            const err = clipTail(raw, keepErrorOutput);
            action.error = err;
            ledger.errors.push({
              ts,
              turn: t.n,
              key: cmdKey(cmd),
              cmd: oneLine(cmd, 200),
              exit: item.exit_code,
              error: err,
            });
          } else {
            ledger.successes.add(cmdKey(cmd));
          }
          t.actions.push(action);
          break;
        }
        case 'FileChange': {
          const changes = item.changes ?? {};
          for (const [fp, change] of Object.entries(changes)) {
            const verb = fileVerb(change);
            const lines = fileLines(change);
            ledger.file(fp, verb, lines, ts);
            t.actions.push({ kind: 'file', verb, path: fp, lines, ts, line: `${verb} ${fp} (~${lines} lines)` });
          }
          break;
        }
        case 'McpToolCall': {
          ledger.tool(item.server, item.tool);
          const title = item.arguments?.title ?? item.arguments?.code ?? item.arguments?.query ?? '';
          t.actions.push({
            kind: 'mcp',
            line: `${item.server}.${item.tool}${title ? ` — ${oneLine(title, 140)}` : ''}`,
            failed: item.result?.isError === true,
            ms: durationMs(item.duration),
            ts,
          });
          break;
        }
        case 'UserMessage': {
          const text = (item.content ?? [])
            .map((c) => c.text ?? '')
            .join('\n')
            .trim();
          const cleaned = text ? extractUserText({ content: [{ text }] }) : null;
          if (cleaned) {
            t.ask = t.ask ? `${t.ask}\n\n${clip(cleaned, maxUserChars)}` : clip(cleaned, maxUserChars);
            t.askSource = t.askSource ?? 'user';
          }
          break;
        }
        case 'WebSearch':
        case 'Extension': {
          if (item.type === 'WebSearch' || item.kind === 'web.search' || item.action?.type === 'search') {
            const q = item.query ?? item.action?.query ?? '';
            ledger.searches.push(q);
            t.actions.push({ kind: 'search', line: `web search — "${oneLine(q, 140)}"`, ts });
          } else {
            t.actions.push({ kind: 'ext', line: `${item.kind ?? 'extension'}`, ts });
          }
          break;
        }
        case 'ImageView': {
          t.actions.push({ kind: 'image', line: `viewed image ${oneLine(item.path, 160)}`, ts });
          break;
        }
        case 'SubAgentActivity': {
          ledger.delegations.push({ kind: item.kind ?? 'sub-agent', ts, summary: item.agent_path ?? '' });
          t.actions.push({
            kind: 'delegate',
            line: `sub-agent ${item.kind ?? 'activity'} ${item.agent_path ?? ''} (thread ${String(item.agent_thread_id ?? '').slice(0, 8)})`,
            ts,
          });
          break;
        }
        case 'CollabAgentToolCall': {
          const to = (item.receiver_agents ?? []).join(', ') || (item.receiver_thread_ids ?? []).length + ' agent(s)';
          t.actions.push({ kind: 'delegate', line: `agent coordination: ${item.tool}${to ? ` → ${to}` : ''}`, ts });
          break;
        }
        case 'Plan': {
          if (item.text) planDoc = item.text;
          break;
        }
        case 'FunctionCallOutput': {
          if (item.name === 'create_thread' || item.name === 'send_message_to_thread') {
            t.actions.push({ kind: 'delegate', line: `${item.name} → sub-agent thread`, ts });
          }
          break;
        }
        case 'ContextCompaction': {
          compactions++;
          t.actions.push({ kind: 'compaction', line: 'context compacted', ts });
          break;
        }
        case 'TodoList':
        case 'PlanUpdate': {
          const steps = (item.items ?? item.plan ?? []).map((s) => ({
            step: s.step ?? s.text ?? String(s),
            status: s.status ?? (s.completed ? 'completed' : 'pending'),
          }));
          if (steps.length) plan = steps;
          break;
        }
        default:
          break;
      }
    }
    rl.close();
  }

  // Drop turns that captured nothing meaningful (pure bookkeeping turns).
  const meaningful = turns.filter(
    (t) => t.ask || t.final || t.actions.length || t.notes.length || t.reasoning.length
  );
  meaningful.forEach((t, i) => {
    t.n = i + 1;
    if (!t.durationMs && t.startedAt && t.endedAt) {
      t.durationMs = Date.parse(t.endedAt) - Date.parse(t.startedAt) || null;
    }
  });

  // Collapse repeated failures of the same command to its final occurrence, and
  // treat a failure as resolved if that same command later exited zero.
  const lastFailure = new Map();
  for (const e of ledger.errors) {
    const prior = lastFailure.get(e.key);
    lastFailure.set(e.key, { ...e, occurrences: (prior?.occurrences ?? 0) + 1 });
  }
  const failures = [...lastFailure.values()].map((e) => ({
    ...e,
    resolved: ledger.successes.has(e.key),
  }));
  const outstanding = failures.filter((e) => !e.resolved);

  // Sessions absent from Codex's own index have no title; the opening request
  // is a far better label than a raw UUID. Skip headings and markup lines so
  // attachment preambles do not become the title.
  const firstAsk = meaningful.find((t) => t.ask)?.ask ?? null;
  const titleLine = firstAsk
    ? (firstAsk.split('\n').find((l) => {
        const s = l.trim();
        return s.length > 12 && !/^[#<>|`*-]/.test(s);
      }) ?? firstAsk)
    : null;
  const derivedTitle =
    thread.title ??
    (titleLine
      ? titleLine.replace(/\s+/g, ' ').trim().slice(0, 70).replace(/\s+\S*$/, '')
      : null);

  return {
    generatedAt: new Date().toISOString(),
    thread: {
      id: thread.threadId,
      title: derivedTitle,
      titleSource: thread.title ? 'codex-index' : firstAsk ? 'first-request' : 'none',
      deepLink: thread.deepLink,
      cwd: meta?.cwd ?? thread.cwd,
      model: thread.model ?? meta?.base_instructions?.provenance?.model ?? null,
      originator: meta?.originator ?? thread.originator ?? null,
      cliVersion: meta?.cli_version ?? null,
      startedAt: thread.startedAt,
      updatedAt: thread.updatedAt,
      bytes: thread.bytes,
      segments: segments.length,
      files: segments,
      workspaceRoots: meta?.workspace_roots ?? null,
    },
    agentsMd,
    plan,
    planDoc,
    turns: meaningful,
    ledger: {
      files: [...ledger.files.values()].sort((a, b) => b.add + b.update - (a.add + a.update)),
      commands: [...ledger.commands.values()].sort((a, b) => b.runs - a.runs),
      errors: failures,
      outstanding,
      mcp: [...ledger.mcp.entries()].map(([k, v]) => ({ tool: k, calls: v })).sort((a, b) => b.calls - a.calls),
      searches: ledger.searches,
      delegations: ledger.delegations,
    },
    stats: {
      sourceBytes: thread.bytes,
      sourceLines: lineCount,
      parseFailures,
      turns: meaningful.length,
      commands: [...ledger.commands.values()].reduce((n, c) => n + c.runs, 0),
      uniqueCommands: ledger.commands.size,
      filesTouched: ledger.files.size,
      errors: ledger.errors.length,
      outstandingErrors: outstanding.length,
      compactions,
      totalTokens,
      lastTokenRecord,
      contextWindow,
    },
  };
}
