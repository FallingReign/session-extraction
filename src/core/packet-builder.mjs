/**
 * Builds the source-neutral packet every adapter produces.
 *
 * Adapters translate their own record formats into calls on this builder;
 * everything about turns, ledgers, failure resolution and titles lives here so
 * Codex and Copilot sessions come out in exactly the same shape.
 *
 * Packet shape:
 *   session  identity and metadata (source, id, title, cwd, model, link, ...)
 *   instructions, plan, planDoc
 *   summaries[]  checkpoint summaries the agent tool itself wrote (model-written)
 *   turns[]  { n, turnId, startedAt, endedAt, ask, askSource, notes[],
 *              reasoning[], actions[], final, durationMs }
 *   ledger   files, commands, errors, outstanding, mcp, searches, delegations
 *   stats    counts and source size
 */
import { clip, clipTail, oneLine, cmdKey } from './text.mjs';

export const DEFAULT_LIMITS = {
  maxUserChars: 4000,
  maxFinalChars: 3000,
  maxNoteChars: 220,
  keepReasoning: true,
  keepErrorOutput: 1200,
};

export class PacketBuilder {
  constructor(limits = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.turns = [];
    this.turnIndex = new Map();
    this.askTexts = new WeakMap();
    this.files = new Map();
    this.reads = new Map();
    this.commands = new Map();
    this.errors = [];
    this.successes = new Set();
    this.mcp = new Map();
    this.searches = [];
    this.delegations = [];
    this.instructions = null;
    this.plan = null;
    this.planDoc = null;
    this.summaries = [];
    this.compactions = 0;
    this.totalTokens = 0;
    this.lastTokenRecord = null;
    this.contextWindow = null;
    this.records = 0;
    this.parseFailures = 0;
  }

  /** Find or create the turn with this id. */
  turn(turnId, ts) {
    if (!turnId) turnId = `orphan-${this.turns.length}`;
    let t = this.turnIndex.get(turnId);
    if (!t) {
      t = {
        n: this.turns.length + 1,
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
      this.turnIndex.set(turnId, t);
      this.turns.push(t);
    }
    if (ts) t.endedAt = ts;
    return t;
  }

  /**
   * Record what the turn was asked to do.
   * mode: 'append' (sets source), 'append-keep-source', or 'if-empty'.
   * A request identical to one already kept for the turn is a replay (agent
   * tools re-record history across segments and compactions) and is skipped.
   */
  ask(turn, text, source = 'user', mode = 'append') {
    if (!text) return;
    if (mode === 'if-empty') {
      if (turn.ask) return;
      turn.ask = clip(text, this.limits.maxUserChars);
      turn.askSource = source;
      return;
    }
    const c = clip(text, this.limits.maxUserChars);
    const kept = this.askTexts.get(turn) ?? new Set();
    const key = c.replace(/\s+/g, ' ').trim();
    if (kept.has(key)) return;
    kept.add(key);
    this.askTexts.set(turn, kept);
    turn.ask = turn.ask ? `${turn.ask}\n\n${c}` : c;
    turn.askSource = mode === 'append-keep-source' ? (turn.askSource ?? source) : source;
  }

  note(turn, text) {
    if (text) turn.notes.push(oneLine(text, this.limits.maxNoteChars));
  }

  final(turn, text) {
    if (text) turn.final = clip(text, this.limits.maxFinalChars);
  }

  reasoning(turn, items) {
    if (!this.limits.keepReasoning) return;
    const clean = items.filter(Boolean).map((s) => s.replace(/\*\*/g, '').trim());
    if (clean.length) turn.reasoning.push(...clean);
  }

  command(turn, { cmd, exit = 0, ms = null, errorText = '', ts, quiet = false }) {
    const ok = (exit ?? 0) === 0;
    const e = this.commands.get(cmd) ?? { cmd, runs: 0, failures: 0 };
    e.runs++;
    if (!ok) e.failures++;
    this.commands.set(cmd, e);

    const action = { kind: 'exec', line: oneLine(cmd, 240), exit: exit ?? 0, ms, ts };
    if (!ok) {
      const err = clipTail(String(errorText ?? '').trim(), this.limits.keepErrorOutput);
      action.error = err;
      this.errors.push({ ts, turn: turn.n, key: cmdKey(cmd), cmd: oneLine(cmd, 200), exit, error: err });
    } else {
      this.successes.add(cmdKey(cmd));
    }
    if (!quiet) turn.actions.push(action);
  }

  fileChange(turn, { path, verb, lines = 0, ts, quiet = false }) {
    const e = this.files.get(path) ?? { path, add: 0, update: 0, delete: 0, lines: 0, firstTs: ts, lastTs: ts };
    e[verb] = (e[verb] ?? 0) + 1;
    e.lines += lines ?? 0;
    e.lastTs = ts;
    this.files.set(path, e);
    if (!quiet) turn.actions.push({ kind: 'file', verb, path, lines, ts, line: `${verb} ${path} (~${lines} lines)` });
  }

  /** A file or folder the agent looked at without changing it. */
  read(turn, { path, tool = 'view', ts, quiet = false }) {
    if (!path) return;
    this.reads.set(path, (this.reads.get(path) ?? 0) + 1);
    if (!quiet) turn.actions.push({ kind: 'read', line: `${tool} ${path}`, ts });
  }

  tool(turn, { name, label = '', failed = false, ms = null, ts, quiet = false }) {
    this.mcp.set(name, (this.mcp.get(name) ?? 0) + 1);
    if (quiet) return;
    turn.actions.push({
      kind: 'mcp',
      line: `${name}${label ? ` — ${oneLine(label, 140)}` : ''}`,
      failed,
      ms,
      ts,
    });
  }

  search(turn, query, ts) {
    this.searches.push(query);
    turn.actions.push({ kind: 'search', line: `web search — "${oneLine(query, 140)}"`, ts });
  }

  action(turn, { kind, line, ts, failed = false }) {
    turn.actions.push({ kind, line, ts, failed });
  }

  delegation(entry) {
    this.delegations.push(entry);
  }

  compaction(turn, line, ts) {
    this.compactions++;
    turn.actions.push({ kind: 'compaction', line, ts });
  }

  /** Assemble the final packet. `session` carries adapter-supplied metadata. */
  finish(session) {
    const meaningful = this.turns.filter(
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
    for (const e of this.errors) {
      const prior = lastFailure.get(e.key);
      lastFailure.set(e.key, { ...e, occurrences: (prior?.occurrences ?? 0) + 1 });
    }
    const failures = [...lastFailure.values()].map((e) => ({ ...e, resolved: this.successes.has(e.key) }));
    const outstanding = failures.filter((e) => !e.resolved);

    // Untitled sessions get their opening request as a label. Headings and
    // markup lines are skipped so attachment preambles never become the title.
    const firstAsk = meaningful.find((t) => t.ask)?.ask ?? null;
    const titleLine = firstAsk
      ? (firstAsk.split('\n').find((l) => {
          const s = l.trim();
          return s.length > 12 && !/^[#<>|`*-]/.test(s);
        }) ?? firstAsk)
      : null;
    const title =
      session.title ??
      (titleLine ? titleLine.replace(/\s+/g, ' ').trim().slice(0, 70).replace(/\s+\S*$/, '') : null);

    const commandList = [...this.commands.values()];
    return {
      generatedAt: new Date().toISOString(),
      session: {
        ...session,
        title,
        titleSource: session.title ? 'source-index' : firstAsk ? 'first-request' : 'none',
      },
      instructions: this.instructions,
      plan: this.plan,
      planDoc: this.planDoc,
      summaries: this.summaries,
      turns: meaningful,
      ledger: {
        files: [...this.files.values()].sort((a, b) => b.add + b.update - (a.add + a.update)),
        reads: [...this.reads.entries()].map(([p, n]) => ({ path: p, reads: n })).sort((a, b) => b.reads - a.reads),
        commands: commandList.sort((a, b) => b.runs - a.runs),
        errors: failures,
        outstanding,
        mcp: [...this.mcp.entries()].map(([k, v]) => ({ tool: k, calls: v })).sort((a, b) => b.calls - a.calls),
        searches: this.searches,
        delegations: this.delegations,
      },
      stats: {
        sourceBytes: session.bytes,
        sourceLines: this.records,
        parseFailures: this.parseFailures,
        turns: meaningful.length,
        commands: commandList.reduce((n, c) => n + c.runs, 0),
        uniqueCommands: this.commands.size,
        filesTouched: this.files.size,
        filesRead: this.reads.size,
        errors: this.errors.length,
        outstandingErrors: outstanding.length,
        compactions: this.compactions,
        totalTokens: this.totalTokens,
        lastTokenRecord: this.lastTokenRecord,
        contextWindow: this.contextWindow,
      },
    };
  }
}
