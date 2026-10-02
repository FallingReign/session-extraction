/**
 * Copilot events.jsonl → packet.
 *
 * Translates Copilot events into PacketBuilder calls. Format knowledge only;
 * bookkeeping lives in core/packet-builder.mjs, turn assignment in tracker.mjs.
 *
 * Reduction rules specific to Copilot:
 *  - A turn is one interaction (interactionId), not one model call.
 *  - user.message counts as a request only when it came from the user. Skill
 *    bodies injected as messages are dropped (the skill call is kept as one
 *    line); messages from another agent are kept as delegated briefs.
 *  - Agent questions (ask_user) are kept with the user's answer, verbatim.
 *  - The answer of a turn is the last message without tool calls, or the one
 *    marked final_answer; earlier text becomes one-line notes.
 *  - reasoningText is plain text and is kept as its first line; encrypted
 *    reasoning is dropped.
 *  - Sub-agent tool calls count in the ledgers but not the timeline, where the
 *    sub-agent appears once with its tool-call count and duration.
 *  - Tool output is dropped except for failing commands.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PacketBuilder } from '../../core/packet-builder.mjs';
import { streamRecords } from '../../core/jsonl.mjs';
import { oneLine } from '../../core/text.mjs';
import { Tracker } from './tracker.mjs';
import {
  SHELL_TOOLS,
  SHELL_FOLLOWUP_TOOLS,
  EDIT_TOOLS,
  SILENT_TOOLS,
  shellOutcome,
  fileChangesOf,
  toolLabel,
} from './tools.mjs';

const CUSTOM_INSTRUCTION_RE = /<custom_instruction>([\s\S]*?)<\/custom_instruction>/g;

function firstLine(text, n = 160) {
  const line = String(text ?? '')
    .split('\n')
    .map((l) => l.replace(/\*\*/g, '').trim())
    .find(Boolean);
  return line ? oneLine(line, n) : null;
}

function formatDuration(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

/** The session's own todo list (session.db), used as plan state. */
async function readTodos(dir) {
  const dbPath = path.join(dir, 'session.db');
  if (!fs.existsSync(dbPath)) return null;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='todos'").get();
      if (!hasTable) return null;
      const rows = db.prepare('SELECT title, status FROM todos ORDER BY rowid').all();
      if (!rows.length) return null;
      return rows.map((r) => ({
        step: r.status === 'blocked' ? `${r.title} (blocked)` : r.title,
        status: r.status === 'done' ? 'completed' : r.status === 'in_progress' ? 'in_progress' : 'pending',
      }));
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function readPlanDoc(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, 'plan.md'), 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}

export async function condense(ref, limits = {}) {
  const b = new PacketBuilder(limits);
  const tracker = new Tracker();
  const delegateActions = new Map();
  const askedQuestions = new Map();
  let start = null;
  let cwd = ref.cwd;
  let model = ref.model;

  const turnFor = (pos, ts) => b.turn(pos.interaction ?? 'session', ts);

  for await (const { rec } of streamRecords(ref.files, { onParseFailure: () => b.parseFailures++ })) {
    b.records++;
    const x = rec.data ?? {};
    const ts = rec.timestamp ?? null;
    const pos = tracker.see(rec);

    switch (rec.type) {
      case 'session.start':
        if (!start) start = x;
        cwd = x.context?.cwd ?? cwd;
        model = x.selectedModel ?? model;
        break;

      case 'session.resume':
      case 'session.context_changed': {
        const ctx = rec.type === 'session.resume' ? x.context : x;
        cwd = ctx?.cwd ?? cwd;
        break;
      }

      case 'system.message':
        if (!b.instructions && typeof x.content === 'string') {
          const blocks = [...x.content.matchAll(CUSTOM_INSTRUCTION_RE)].map((m) => m[1].trim()).filter(Boolean);
          if (blocks.length) b.instructions = blocks.join('\n\n');
        }
        break;

      case 'user.message': {
        if (pos.sub) break;
        const source = x.source ?? 'user';
        if (source.startsWith('skill-')) break;
        let text = typeof x.content === 'string' ? x.content.trim() : '';
        const attached = (x.attachments ?? []).map((a) => a?.displayName ?? a?.path).filter(Boolean);
        if (attached.length) text += `${text ? '\n\n' : ''}[attached: ${attached.join(', ')}]`;
        if (!text) break;
        const t = turnFor(pos, ts);
        if (source.startsWith('agent-')) b.ask(t, text, 'delegated-message');
        else b.ask(t, text, 'user');
        break;
      }

      case 'assistant.message': {
        if (pos.sub) break;
        const t = turnFor(pos, ts);
        if (x.reasoningText) {
          const thought = firstLine(x.reasoningText);
          if (thought) b.reasoning(t, [thought]);
        }
        const text = typeof x.content === 'string' ? x.content.trim() : '';
        if (!text) break;
        const usesTools = (x.toolRequests ?? []).length > 0;
        const isFinal = x.phase === 'final_answer' || (!x.phase && !usesTools);
        if (isFinal) {
          if (t.final) b.note(t, t.final);
          b.final(t, text);
        } else {
          b.note(t, text);
        }
        if (x.model) model = x.model;
        break;
      }

      case 'tool.execution_start': {
        const call = pos.call;
        if (pos.sub) break;
        if (call.name === 'task') {
          const a = call.args ?? {};
          const t = turnFor(pos, ts);
          const line = `sub-agent ${a.agent_type ?? 'agent'}: ${oneLine(a.name ?? a.description ?? '', 120)}${a.mode === 'background' ? ' (background)' : ''}`;
          b.action(t, { kind: 'delegate', line, ts });
          delegateActions.set(call.id, t.actions[t.actions.length - 1]);
        }
        if (call.name === 'ask_user') askedQuestions.set(call.id, call.args?.message ?? call.args?.question ?? '');
        break;
      }

      case 'tool.execution_complete':
        handleComplete(b, turnFor(pos, ts), pos, x, ts, cwd, { delegateActions, askedQuestions });
        break;

      case 'subagent.completed':
      case 'subagent.failed': {
        const action = delegateActions.get(x.toolCallId);
        if (!action) break;
        const bits = [];
        if (x.totalToolCalls != null) bits.push(`${x.totalToolCalls} tool calls`);
        if (x.durationMs) bits.push(formatDuration(x.durationMs));
        if (rec.type === 'subagent.failed') {
          bits.push('failed');
          action.failed = true;
        }
        if (bits.length) action.line += ` — ${bits.join(', ')}`;
        break;
      }

      case 'session.compaction_complete': {
        if (pos.sub) break;
        const t = turnFor(pos, ts);
        const pre = x.preCompactionTokens;
        const post = x.postCompactionTokens;
        b.compaction(t, `context compacted${pre && post ? ` (${pre.toLocaleString()} → ${post.toLocaleString()} tokens)` : ''}`, ts);
        if (x.summaryContent) b.summaries.push({ ts, text: x.summaryContent });
        break;
      }

      case 'session.task_complete':
        if (x.summary) b.final(turnFor(pos, ts), x.summary);
        break;

      case 'abort':
        if (pos.interaction) b.action(turnFor(pos, ts), { kind: 'abort', line: `stopped: ${x.reason ?? 'aborted'}`, ts });
        break;

      case 'session.error':
        if (pos.interaction) {
          b.action(turnFor(pos, ts), { kind: 'error', line: `error: ${oneLine(x.message ?? x.errorType, 200)}`, ts, failed: true });
        }
        break;

      case 'session.model_change':
        if (x.newModel) {
          model = x.newModel;
          if (pos.interaction) b.action(turnFor(pos, ts), { kind: 'model', line: `model → ${x.newModel}`, ts });
        }
        break;

      case 'session.shutdown': {
        const d = x.tokenDetails ?? {};
        b.totalTokens += (d.input?.tokenCount ?? 0) + (d.output?.tokenCount ?? 0);
        break;
      }

      default:
        break;
    }
  }

  b.plan = await readTodos(ref.dir);
  b.planDoc = readPlanDoc(ref.dir);

  return b.finish({
    source: 'copilot',
    id: ref.id,
    title: ref.title,
    link: ref.link,
    resume: ref.resume,
    cwd: ref.cwd ?? cwd,
    model: model ?? null,
    originator: ref.originator ?? start?.producer ?? null,
    clientVersion: start?.copilotVersion ?? ref.clientVersion ?? null,
    startedAt: ref.startedAt ?? start?.startTime ?? null,
    updatedAt: ref.updatedAt,
    bytes: ref.bytes,
    segmentCount: 1,
    files: ref.files,
    gitRoot: ref.gitRoot ?? null,
    branch: ref.branch ?? null,
    repository: ref.repository ?? null,
  });
}

function handleComplete(b, t, pos, x, ts, cwd, ctx) {
  const call = pos.call;
  if (!call) {
    b.tool(t, { name: 'unknown-tool', failed: x.success === false, ts, quiet: pos.sub });
    return;
  }
  const quiet = pos.sub;
  const name = call.name;
  const failed = x.success === false;

  if (SILENT_TOOLS.has(name)) return;

  if (SHELL_TOOLS.has(name)) {
    const cmd = String(call.args?.command ?? '(unknown command)');
    const out = shellOutcome(x);
    b.command(t, { cmd, exit: out.exit, errorText: out.errorText, ts, quiet });
    return;
  }

  if (EDIT_TOOLS.has(name) || name === 'create' || name === 'apply_patch') {
    if (failed) {
      if (!quiet) {
        const target = call.args?.path ?? 'patch';
        b.action(t, { kind: 'file', line: `${name} ${target} — ${oneLine(x.error?.message ?? 'failed', 120)}`, ts, failed: true });
      }
      return;
    }
    for (const f of fileChangesOf(call, cwd)) {
      if (f.path) b.fileChange(t, { path: f.path, verb: f.verb, lines: f.lines, ts, quiet });
    }
    return;
  }

  if (name === 'view') {
    if (failed && !quiet) {
      b.action(t, { kind: 'read', line: `view ${call.args?.path ?? ''} — ${oneLine(x.error?.message ?? 'failed', 120)}`, ts, failed: true });
      return;
    }
    if (!failed) b.read(t, { path: call.args?.path, tool: 'view', ts, quiet });
    return;
  }

  if (name === 'web_search') {
    if (!quiet) b.search(t, call.args?.query ?? '', ts);
    return;
  }

  if (name === 'ask_user') {
    const question = ctx.askedQuestions.get(call.id) ?? call.args?.message ?? '';
    const answer = String(x.result?.content ?? x.error?.message ?? '').trim();
    if (!quiet && (question || answer)) {
      b.ask(t, `**Agent asked:** ${question}\n\n**User answered:** ${answer || '(no answer)'}`, 'user', 'append-keep-source');
    }
    return;
  }

  if (name === 'task') {
    const report = String(x.result?.content ?? '').trim();
    b.delegation({ kind: call.args?.agent_type ?? 'agent', ts, summary: oneLine(call.args?.name ?? call.args?.description, 160), report: oneLine(report, 400) });
    const action = ctx.delegateActions.get(call.id);
    if (action && failed) action.failed = true;
    return;
  }

  if (name === 'skill') {
    if (!quiet) b.action(t, { kind: 'skill', line: `skill ${call.args?.skill ?? ''}`, ts, failed });
    return;
  }

  const label = SHELL_FOLLOWUP_TOOLS.has(name) ? `shell ${call.args?.shellId ?? ''}` : toolLabel(call);
  b.tool(t, { name: call.mcp ?? name, label, failed, ts, quiet });
}
