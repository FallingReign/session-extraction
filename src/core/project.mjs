/**
 * Project view: every session whose working folder is a given project folder,
 * from every source, condensed and aggregated into one analysis-ready record.
 *
 * Each session is condensed in turn and reduced to a card plus the facts that
 * aggregate across sessions; the full packet is then released, so memory stays
 * bounded however many sessions a project has.
 */
import { oneLine, cmdKey } from './text.mjs';
import { adapterFor } from './sources.mjs';

const userAsks = (packet) =>
  packet.turns
    .filter((t) => t.ask)
    .map((t) => ({ ts: t.startedAt, turn: t.n, source: t.askSource ?? 'user', text: t.ask }));

const ERROR_WORDS = /error|fail|exception|cannot|can't|not found|not recognized|denied|fatal|refused|invalid|missing|timed? ?out/i;

/** The most informative single line of an error: the last one naming a problem, else the last with words. */
function telltaleLine(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /[A-Za-z]{3}/.test(l) && !/^[+~|]/.test(l));
  return [...lines].reverse().find((l) => ERROR_WORDS.test(l)) ?? lines[lines.length - 1] ?? '';
}

function cardOf(ref, packet, code) {
  const asks = userAsks(packet);
  const finals = packet.turns.filter((t) => t.final);
  const s = packet.stats;
  return {
    code,
    source: ref.source,
    id: ref.id,
    title: packet.session.title ?? ref.title ?? null,
    link: ref.link,
    resume: ref.resume ?? null,
    cwd: packet.session.cwd ?? ref.cwd,
    model: packet.session.model ?? ref.model ?? null,
    startedAt: ref.startedAt ?? packet.turns[0]?.startedAt ?? null,
    updatedAt: ref.updatedAt,
    bytes: ref.bytes,
    stats: {
      turns: s.turns,
      commands: s.commands,
      filesChanged: s.filesTouched,
      filesRead: s.filesRead ?? 0,
      outstandingFailures: s.outstandingErrors,
      compactions: s.compactions,
    },
    firstAsk: asks[0] ?? null,
    lastAsk: asks.length > 1 ? asks[asks.length - 1] : null,
    lastReply: finals.length ? { ts: finals[finals.length - 1].startedAt, text: finals[finals.length - 1].final } : null,
    openPlan: (packet.plan ?? []).filter((p) => p.status !== 'completed'),
    planSize: (packet.plan ?? []).length,
    files: packet.ledger.files.map((f) => ({ path: f.path, add: f.add, update: f.update, delete: f.delete })),
    outstanding: packet.ledger.outstanding.map((e) => ({
      cmd: e.cmd,
      exit: e.exit,
      occurrences: e.occurrences,
      lastLine: oneLine(telltaleLine(e.error), 200),
    })),
    asks,
    tools: packet.ledger.mcp,
  };
}

/**
 * Condense and aggregate sessions (already selected by the caller).
 * onSession(ref, index, total) reports progress.
 */
export async function buildProject(folder, refs, { onSession } = {}) {
  const ordered = [...refs].sort((a, b) => Date.parse(a.startedAt ?? a.updatedAt) - Date.parse(b.startedAt ?? b.updatedAt));
  const cards = [];
  const files = new Map();
  const failures = new Map();
  const tools = new Map();

  for (let i = 0; i < ordered.length; i++) {
    const ref = ordered[i];
    onSession?.(ref, i, ordered.length);
    const packet = await adapterFor(ref.source).condense(ref);
    const card = cardOf(ref, packet, `S${i + 1}`);
    cards.push(card);

    for (const f of card.files) {
      const e = files.get(f.path) ?? { path: f.path, sessions: [], changes: 0 };
      e.sessions.push(card.code);
      e.changes += (f.add ?? 0) + (f.update ?? 0) + (f.delete ?? 0);
      files.set(f.path, e);
    }
    for (const o of card.outstanding) {
      const key = cmdKey(o.cmd);
      const e = failures.get(key) ?? { cmd: o.cmd, sessions: [], occurrences: 0, lastLine: '' };
      e.sessions.push(card.code);
      e.occurrences += o.occurrences;
      e.lastLine = o.lastLine || e.lastLine;
      failures.set(key, e);
    }
    for (const t of card.tools) tools.set(t.tool, (tools.get(t.tool) ?? 0) + t.calls);
  }

  const sum = (k) => cards.reduce((n, c) => n + (c.stats[k] ?? 0), 0);
  const bySource = {};
  for (const c of cards) bySource[c.source] = (bySource[c.source] ?? 0) + 1;

  return {
    generatedAt: new Date().toISOString(),
    folder,
    sessions: cards,
    totals: {
      sessions: cards.length,
      bySource,
      turns: sum('turns'),
      commands: sum('commands'),
      filesChanged: files.size,
      outstandingFailures: sum('outstandingFailures'),
      bytes: cards.reduce((n, c) => n + (c.bytes ?? 0), 0),
      startedAt: cards[0]?.startedAt ?? null,
      updatedAt: cards.reduce((m, c) => (Date.parse(c.updatedAt) > Date.parse(m ?? 0) ? c.updatedAt : m), null),
    },
    files: [...files.values()].sort((a, b) => b.sessions.length - a.sessions.length || b.changes - a.changes),
    failures: [...failures.values()].sort((a, b) => b.sessions.length - a.sessions.length || b.occurrences - a.occurrences),
    tools: [...tools.entries()].map(([tool, calls]) => ({ tool, calls })).sort((a, b) => b.calls - a.calls),
  };
}
