/**
 * Renders a condensed packet as Markdown built for agent ingestion:
 * front-loaded orientation, then the timeline, then reference ledgers.
 *
 * Turn fidelity is decided by the budget planner, not by this module; each turn
 * arrives tagged full / brief / digest and is rendered accordingly.
 */
import { planBudget, estTokens } from './budget.mjs';

const pad = (n) => String(n).padStart(2, '0');

function fmtDuration(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${pad(s % 60)}s`;
  return `${Math.floor(m / 60)}h${pad(m % 60)}m`;
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const human = (n) =>
  n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;

const ICON = {
  exec: '$',
  file: '±',
  mcp: '⚙',
  search: '?',
  ext: '·',
  image: '▣',
  delegate: '→',
  compaction: '✂',
};

/** Collapse a turn's actions into deduped, run-length-encoded lines. */
function collapseActions(actions) {
  const out = [];
  for (const a of actions) {
    const key = `${a.kind}|${a.line}`;
    const prev = out[out.length - 1];
    if (prev && prev.key === key) {
      prev.count++;
      if (a.error) prev.error = a.error;
      continue;
    }
    out.push({ ...a, key, count: 1 });
  }
  return out;
}

const dedupe = (arr) => [...new Set(arr)];

function blockquote(text) {
  return String(text)
    .trim()
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}

function clipDoc(s, n) {
  const t = String(s ?? '').trim();
  return t.length <= n ? t : t.slice(0, n) + `\n\n…[+${t.length - n} chars omitted]`;
}

const oneLine = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n) + '…';
};

/** The parts of the packet a resuming agent always needs, whatever the budget. */
function renderSpine(packet, opts) {
  const { maxFiles = 60 } = opts;
  const L = [];
  const t = packet.thread;

  L.push(`# Codex session handoff — ${t.title ?? 'untitled'}`);
  L.push('');
  L.push('> Condensed record of a Codex session, produced deterministically — no summarisation model touched it.');
  L.push('> Everything below is drawn verbatim or by rule from the original transcript.');
  L.push('> Start at **Where things stand**; read the timeline only if you need the history.');
  L.push('');
  L.push('| | |');
  L.push('|---|---|');
  L.push(`| Thread | \`${t.id}\` |`);
  L.push(`| Deep link | ${t.deepLink} |`);
  L.push(`| Working dir | \`${t.cwd ?? '—'}\` |`);
  L.push(`| Model | ${t.model ?? '—'} (${t.originator ?? '—'}) |`);
  L.push(`| Span | ${fmtTime(t.startedAt)} → ${fmtTime(t.updatedAt)} |`);
  L.push(`| Source | ${human(t.bytes)}, ${t.segments} file(s), ${packet.stats.sourceLines.toLocaleString()} records |`);
  L.push(
    `| Activity | ${packet.stats.turns} turns · ${packet.stats.commands} commands · ${packet.stats.filesTouched} files · ${packet.stats.outstandingErrors ?? 0} outstanding failure(s)${packet.stats.compactions ? ` · ${packet.stats.compactions} compaction(s)` : ''} |`
  );
  L.push('');

  const lastAsk = [...packet.turns].reverse().find((x) => x.ask);
  const lastFinal = [...packet.turns].reverse().find((x) => x.final);

  L.push('## Where things stand');
  L.push('');
  if (lastAsk) {
    const label =
      lastAsk.askSource === 'delegated-in' || lastAsk.askSource === 'delegated-message'
        ? 'Most recent brief handed to the agent'
        : 'Most recent request from the user';
    L.push(`**${label}** _(turn ${lastAsk.n}, ${fmtTime(lastAsk.startedAt)})_:`);
    L.push('');
    L.push(blockquote(lastAsk.ask));
    L.push('');
  }
  if (lastFinal) {
    L.push(`**Last thing the Codex agent reported** _(turn ${lastFinal.n}, ${fmtTime(lastFinal.startedAt)})_:`);
    L.push('');
    L.push(blockquote(lastFinal.final));
    L.push('');
  }
  if (!lastAsk && !lastFinal) {
    L.push('_No user request or final agent message was recorded._');
    L.push('');
  }

  if (packet.plan?.length) {
    L.push('### Plan state at the end');
    L.push('');
    for (const s of packet.plan) {
      const box = s.status === 'completed' ? '[x]' : s.status === 'in_progress' ? '[~]' : '[ ]';
      L.push(`- ${box} ${s.step}`);
    }
    L.push('');
  }

  if (packet.planDoc) {
    L.push('<details><summary>Plan document written during the session</summary>');
    L.push('');
    L.push(clipDoc(packet.planDoc, 6000));
    L.push('');
    L.push('</details>');
    L.push('');
  }

  const outstanding = packet.ledger.outstanding ?? [];
  if (outstanding.length) {
    L.push('### Outstanding failures');
    L.push('');
    L.push('Commands that failed and were never observed to succeed afterwards. Re-verify before assuming they are fixed.');
    L.push('');
    for (const e of outstanding.slice(-10)) {
      L.push(`- \`${e.cmd}\` → exit ${e.exit}${e.occurrences > 1 ? ` (failed ${e.occurrences}×)` : ''}`);
      if (e.error) {
        L.push('');
        L.push('  ```');
        for (const line of e.error.split('\n').slice(-8)) L.push('  ' + line);
        L.push('  ```');
      }
    }
    if (outstanding.length > 10) {
      L.push(`- _…${outstanding.length - 10} further outstanding failures (full list in the JSON packet)_`);
    }
    L.push('');
  }
  const resolved = (packet.ledger.errors ?? []).filter((e) => e.resolved).length;
  if (resolved) {
    L.push(`_${resolved} other command(s) failed at some point but later succeeded — treated as resolved._`);
    L.push('');
  }

  if (packet.ledger.files.length) {
    L.push('## Files touched');
    L.push('');
    L.push('| File | Created | Edited | ~Lines |');
    L.push('|---|--:|--:|--:|');
    for (const f of packet.ledger.files.slice(0, maxFiles)) {
      L.push(`| \`${f.path}\` | ${f.add || ''} | ${f.update || ''} | ${f.lines || ''} |`);
    }
    if (packet.ledger.files.length > maxFiles) {
      L.push(`| _…${packet.ledger.files.length - maxFiles} more (full list in the JSON packet)_ | | | |`);
    }
    L.push('');
  }

  return L;
}

function renderReference(packet, { maxCommands = 25 } = {}) {
  const L = [];
  L.push('## Reference');
  L.push('');
  if (packet.ledger.commands.length) {
    L.push('<details><summary>Commands run (deduplicated, most frequent first)</summary>');
    L.push('');
    L.push('```');
    for (const c of packet.ledger.commands.slice(0, maxCommands)) {
      L.push(`${String(c.runs).padStart(4)}× ${oneLine(c.cmd, 200)}${c.failures ? `   (${c.failures} failed)` : ''}`);
    }
    if (packet.ledger.commands.length > maxCommands) {
      L.push(`… ${packet.ledger.commands.length - maxCommands} more unique commands`);
    }
    L.push('```');
    L.push('');
    L.push('</details>');
    L.push('');
  }
  if (packet.ledger.mcp.length) {
    L.push(`**Tools used:** ${packet.ledger.mcp.slice(0, 20).map((m) => `${m.tool} ×${m.calls}`).join(', ')}`);
    L.push('');
  }
  if (packet.ledger.searches.length) {
    L.push(
      `**Web searches:** ${dedupe(packet.ledger.searches).slice(0, 15).map((s) => `"${oneLine(s, 90)}"`).join(', ')}`
    );
    L.push('');
  }
  if (packet.agentsMd) {
    L.push('<details><summary>AGENTS.md instructions in force during this session</summary>');
    L.push('');
    L.push('```');
    L.push(packet.agentsMd.trim());
    L.push('```');
    L.push('');
    L.push('</details>');
    L.push('');
  }
  return L;
}

function renderTurn(turn, tier) {
  const L = [];
  const when = fmtTime(turn.startedAt);
  const dur = fmtDuration(turn.durationMs);
  const cmds = turn.actions.filter((a) => a.kind === 'exec').length;
  const fileActions = turn.actions.filter((a) => a.kind === 'file');

  if (tier === 'digest') {
    const bits = [];
    if (turn.ask) bits.push(`asked: ${oneLine(turn.ask, 150)}`);
    if (turn.final) bits.push(`answered: ${oneLine(turn.final, 150)}`);
    const counts = [];
    if (cmds) counts.push(`${cmds} cmd`);
    if (fileActions.length) counts.push(`${fileActions.length} file edit`);
    L.push(
      `- **T${turn.n}** ${when}${counts.length ? ` · ${counts.join(', ')}` : ''}${bits.length ? ` — ${bits.join(' / ')}` : ''}`
    );
    return L;
  }

  L.push(`### Turn ${turn.n} — ${when}${dur ? ` (${dur})` : ''}`);
  L.push('');

  if (turn.ask) {
    const label =
      turn.askSource === 'delegated-in'
        ? 'Delegated brief'
        : turn.askSource === 'delegated-message'
          ? 'Message from parent agent'
          : 'User';
    L.push(`**${label}:**`);
    L.push('');
    L.push(blockquote(tier === 'brief' ? clipDoc(turn.ask, 1200) : turn.ask));
    L.push('');
  }

  if (tier === 'full') {
    if (turn.reasoning.length) {
      L.push(`**Reasoning trail:** ${dedupe(turn.reasoning).slice(0, 25).join(' · ')}`);
      L.push('');
    }
    if (turn.notes.length) {
      for (const n of dedupe(turn.notes)) L.push(`_${n}_`);
      L.push('');
    }
    const actions = collapseActions(turn.actions);
    if (actions.length) {
      L.push('```');
      for (const a of actions) {
        const mark = a.exit ? ' ✗' : '';
        const times = a.count > 1 ? ` ×${a.count}` : '';
        L.push(`${ICON[a.kind] ?? '·'} ${a.line}${times}${mark}`);
      }
      L.push('```');
      L.push('');
    }
  } else {
    const bits = [];
    if (cmds) bits.push(`${cmds} command(s)`);
    if (fileActions.length) {
      bits.push(
        `${fileActions.length} file change(s): ${dedupe(fileActions.map((f) => f.path)).slice(0, 5).join(', ')}`
      );
    }
    if (bits.length) {
      L.push(`_Activity: ${bits.join('; ')}._`);
      L.push('');
    }
  }

  if (turn.final) {
    L.push('**Agent:**');
    L.push('');
    L.push(blockquote(tier === 'brief' ? clipDoc(turn.final, 1200) : turn.final));
    L.push('');
  }
  return L;
}

export function renderMarkdown(packet, opts = {}) {
  const { budgetTokens = null } = opts;
  // On very large sessions the ledgers alone can exceed the budget, so scale
  // them to a share of it rather than letting them crowd out the timeline.
  const ledgerShare = budgetTokens ? Math.max(3000, Math.round(budgetTokens * 0.25)) : Infinity;
  const maxFiles = opts.maxFiles ?? (budgetTokens ? Math.max(20, Math.round(ledgerShare / 40)) : 5000);
  const maxCommands = opts.maxCommands ?? (budgetTokens ? Math.max(15, Math.round(ledgerShare / 60)) : 5000);

  const spine = renderSpine(packet, { ...opts, maxFiles });
  const reference = renderReference(packet, { maxCommands });
  const spineTokens = estTokens(spine.join('\n').length + reference.join('\n').length);

  const budget = planBudget(packet, { budgetTokens, spineTokens });

  const L = [...spine];
  L.push('## Conversation timeline');
  L.push('');
  if (budget.fitted) {
    L.push(
      `_Fitted to a ~${budgetTokens.toLocaleString()} token budget: ` +
        `${budget.counts.full} turn(s) in full detail, ${budget.counts.brief} abbreviated, ` +
        `${budget.counts.digest} reduced to one line, ${budget.counts.omit} omitted. ` +
        `The ${budget.guaranteed} most recent turn(s) are always kept in full. ` +
        `Unabridged this would be ~${budget.fullTokens.toLocaleString()} tokens._`
    );
    L.push('');
    L.push(
      `_Nothing is permanently lost: \`codex-migrate search ${packet.thread.id.slice(0, 8)} "<text>"\` ` +
        `searches the complete original transcript, including command output this packet drops._`
    );
    L.push('');
  }

  // Digest runs are grouped so the timeline never becomes a wall of bullets.
  let inDigestRun = false;
  let omitted = 0;
  let omittedFrom = null;
  let omittedTo = null;
  const closeDigest = () => {
    if (!inDigestRun) return;
    L.push('');
    L.push('</details>');
    L.push('');
    inDigestRun = false;
  };

  for (const turn of packet.turns) {
    const tier = budget.tiers.get(turn.turnId) ?? 'full';
    if (tier === 'omit') {
      omitted++;
      omittedFrom = omittedFrom ?? turn;
      omittedTo = turn;
      continue;
    }
    if (omitted) {
      closeDigest();
      L.push(
        `> **${omitted} earlier turn(s) omitted** (turns ${omittedFrom.n}–${omittedTo.n}, ` +
          `${fmtTime(omittedFrom.startedAt)} → ${fmtTime(omittedTo.startedAt)}). ` +
          `Their file changes and commands are still counted in the ledgers above. ` +
          `Recover any of them with \`codex-migrate turn ${packet.thread.id.slice(0, 8)} <n>\`.`
      );
      L.push('');
      omitted = 0;
      omittedFrom = null;
    }
    if (tier === 'digest' && !inDigestRun) {
      L.push('<details><summary>Earlier turns (one line each)</summary>');
      L.push('');
      inDigestRun = true;
    }
    if (tier !== 'digest' && inDigestRun) closeDigest();
    L.push(...renderTurn(turn, tier));
  }
  closeDigest();
  if (omitted) {
    L.push(
      `> **${omitted} turn(s) omitted** (turns ${omittedFrom.n}–${omittedTo.n}). ` +
        `Recover with \`codex-migrate turn ${packet.thread.id.slice(0, 8)} <n>\`.`
    );
    L.push('');
  }

  L.push(...reference);
  L.push('---');
  L.push(
    `_Generated ${packet.generatedAt} from ${human(packet.stats.sourceBytes)} of Codex rollout data. Deterministic condensation — no model in the loop._`
  );

  return { markdown: L.join('\n'), budget };
}
