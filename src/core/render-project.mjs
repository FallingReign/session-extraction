/**
 * Renders a project view (see core/project.mjs) as Markdown for review and
 * analysis across sessions.
 *
 * Fixed sections (always present): overview, session table, latest state,
 * open plan items, files changed in the most sessions, recurring failures.
 * Flexible sections share the remaining budget: every user request across all
 * sessions (one line each, newest kept first), and per-session cards (newest
 * in full, older ones abbreviated or left to the table).
 */
import path from 'node:path';
import { fitTiers, estTokens } from './budget.mjs';
import { fmtTime, fmtDate, fmtSize, blockquote, clipDoc, shortLine, cell, sourceLabel } from './format.mjs';

const CARD_TIERS = ['omit', 'brief', 'full'];
const ASK_LINE = 220;
const len = (s) => (s ? String(s).length : 0);

/** Paths inside the project folder are shown relative to it. */
const relativeTo = (folder) => (p) => {
  const rel = path.relative(folder, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p;
};

function cardCost(card, tier) {
  if (tier === 'omit') return 0;
  if (tier === 'brief') return 160 + Math.min(len(card.firstAsk?.text), 300) + Math.min(len(card.lastReply?.text), 300);
  return (
    200 +
    Math.min(len(card.firstAsk?.text), 800) +
    Math.min(len(card.lastAsk?.text), 800) +
    Math.min(len(card.lastReply?.text), 1200) +
    Math.min(card.files.length, 10) * 90 +
    Math.min(card.outstanding.length, 3) * 220 +
    Math.min(card.openPlan.length, 8) * 90
  );
}

const askLine = (a) =>
  `- **${a.code}** ${fmtTime(a.ts)} — ${a.source !== 'user' ? '_(brief from another agent)_ ' : ''}${shortLine(a.text, ASK_LINE)}`;

function renderSpine(p) {
  const L = [];
  const t = p.totals;
  const rel = relativeTo(p.folder);
  const sources = Object.entries(t.bySource)
    .map(([s, n]) => `${n} ${sourceLabel(s)}`)
    .join(', ');

  L.push(`# Project view — ${p.folder}`);
  L.push('');
  L.push('> Every recorded agent session for this folder, condensed deterministically. Requests and replies are quoted verbatim;');
  L.push('> everything else is reduced by fixed rules. Session codes (S1, S2, …) are in start order and are used throughout.');
  L.push('');
  L.push('| | |');
  L.push('|---|---|');
  L.push(`| Folder | \`${p.folder}\` |`);
  L.push(`| Sessions | ${t.sessions} (${sources || 'none'}) |`);
  L.push(`| Span | ${fmtTime(t.startedAt)} → ${fmtTime(t.updatedAt)} |`);
  L.push(
    `| Activity | ${t.turns} turns · ${t.commands} commands · ${t.filesChanged} files changed · ${t.outstandingFailures} outstanding failure(s) |`
  );
  L.push(`| Source data | ${fmtSize(t.bytes)} |`);
  L.push('');

  L.push('## Sessions');
  L.push('');
  L.push('| | Tool | Id | Started | Last active | Turns | Cmds | Files | Fails | Title |');
  L.push('|---|---|---|---|---|--:|--:|--:|--:|---|');
  for (const c of p.sessions) {
    L.push(
      `| ${c.code} | ${sourceLabel(c.source)} | \`${c.id.slice(0, 8)}\` | ${fmtDate(c.startedAt)} | ${fmtDate(c.updatedAt)} | ${c.stats.turns} | ${c.stats.commands} | ${c.stats.filesChanged} | ${c.stats.outstandingFailures || ''} | ${cell(shortLine(c.title ?? '—', 70))} |`
    );
  }
  L.push('');

  const latest = [...p.sessions].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  if (latest) {
    L.push(`## Latest state — ${latest.code}`);
    L.push('');
    const ask = latest.lastAsk ?? latest.firstAsk;
    if (ask) {
      L.push(`**Most recent request** _(${fmtTime(ask.ts)})_:`);
      L.push('');
      L.push(blockquote(clipDoc(ask.text, 1500)));
      L.push('');
    }
    if (latest.lastReply) {
      L.push(`**Last reply** _(${fmtTime(latest.lastReply.ts)})_:`);
      L.push('');
      L.push(blockquote(clipDoc(latest.lastReply.text, 2000)));
      L.push('');
    }
  }

  const open = p.sessions.filter((c) => c.openPlan.length).reverse();
  if (open.length) {
    L.push('## Unfinished plan items');
    L.push('');
    for (const c of open.slice(0, 5)) {
      L.push(`- **${c.code}** (${c.openPlan.length} of ${c.planSize} open): ${c.openPlan.slice(0, 6).map((s) => `${s.status === 'in_progress' ? '[~]' : '[ ]'} ${shortLine(s.step, 80)}`).join(' · ')}${c.openPlan.length > 6 ? ' · …' : ''}`);
    }
    L.push('');
  }

  if (p.files.length) {
    const shared = p.files.filter((f) => f.sessions.length > 1);
    const list = (shared.length ? shared : p.files).slice(0, 25);
    L.push(shared.length ? '## Files changed in more than one session' : '## Most-changed files');
    L.push('');
    L.push('_Paths are relative to the project folder unless outside it._');
    L.push('');
    L.push('| File | Sessions | Changes |');
    L.push('|---|---|--:|');
    for (const f of list) L.push(`| \`${cell(rel(f.path))}\` | ${[...new Set(f.sessions)].join(', ')} | ${f.changes} |`);
    if ((shared.length || p.files.length) > list.length) L.push(`| _…${(shared.length || p.files.length) - list.length} more in the JSON_ | | |`);
    L.push('');
  }

  if (p.failures.length) {
    L.push('## Outstanding failures');
    L.push('');
    L.push('Commands that failed and were never seen to succeed later in the same session. Repeats across sessions come first.');
    L.push('');
    for (const f of p.failures.slice(0, 10)) {
      L.push(`- \`${shortLine(f.cmd, 160)}\` — ${[...new Set(f.sessions)].join(', ')}${f.occurrences > 1 ? `, failed ${f.occurrences}×` : ''}${f.lastLine ? `  \n  _${cell(f.lastLine)}_` : ''}`);
    }
    if (p.failures.length > 10) L.push(`- _…${p.failures.length - 10} more in the JSON_`);
    L.push('');
  }
  return L;
}

function renderCard(c, tier, rel) {
  const L = [];
  L.push(`### ${c.code} — ${c.title ?? 'untitled'}`);
  L.push('');
  L.push(
    `_${sourceLabel(c.source)} · \`${c.id}\` · ${fmtTime(c.startedAt)} → ${fmtTime(c.updatedAt)} · ${c.stats.turns} turns · ${c.stats.commands} commands · ${c.stats.filesChanged} files changed${c.cwd ? ` · \`${c.cwd}\`` : ''}_`
  );
  L.push('');
  const cap = (n) => (tier === 'full' ? n : Math.min(n, 300));
  if (c.firstAsk) {
    L.push('**Opening request:**');
    L.push('');
    L.push(blockquote(clipDoc(c.firstAsk.text, cap(800))));
    L.push('');
  }
  if (tier === 'full' && c.lastAsk) {
    L.push(`**Last request** _(${fmtTime(c.lastAsk.ts)})_:`);
    L.push('');
    L.push(blockquote(clipDoc(c.lastAsk.text, 800)));
    L.push('');
  }
  if (c.lastReply) {
    L.push('**Last reply:**');
    L.push('');
    L.push(blockquote(clipDoc(c.lastReply.text, cap(1200))));
    L.push('');
  }
  if (tier === 'full') {
    if (c.files.length) {
      L.push(`**Files changed:** ${c.files.slice(0, 10).map((f) => `\`${rel(f.path)}\``).join(', ')}${c.files.length > 10 ? `, …${c.files.length - 10} more` : ''}`);
      L.push('');
    }
    if (c.outstanding.length) {
      L.push(`**Outstanding failures:** ${c.outstanding.slice(0, 3).map((o) => `\`${shortLine(o.cmd, 100)}\` (exit ${o.exit})`).join('; ')}${c.outstanding.length > 3 ? `; …${c.outstanding.length - 3} more` : ''}`);
      L.push('');
    }
    if (c.openPlan.length) {
      L.push(`**Open plan items:** ${c.openPlan.slice(0, 8).map((s) => shortLine(s.step, 80)).join(' · ')}`);
      L.push('');
    }
  }
  return L;
}

export function renderProject(p, { budgetTokens = null } = {}) {
  const spine = renderSpine(p);
  const footer = [
    '## Drill down',
    '',
    '- One session in detail: `session-extract view <id>`',
    '- Anything said or run in a session, including output: `session-extract search <id> "<text>"`',
    '- One turn in full: `session-extract turn <id> <n>`',
    '',
    '---',
    `_Generated ${p.generatedAt} from ${fmtSize(p.totals.bytes)} of session data. Deterministic condensation — no model in the loop._`,
  ];
  const spineTokens = estTokens(spine.join('\n').length + footer.join('\n').length);

  const asks = p.sessions.flatMap((c) => c.asks.map((a) => ({ ...a, code: c.code })));
  asks.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const askCost = (a) => Math.min(len(a.text), ASK_LINE) + 40;

  let keptAsks = asks;
  let cardTiers = p.sessions.map(() => 'full');
  let fitted = false;

  if (budgetTokens) {
    const remaining = Math.max(0, budgetTokens - spineTokens);
    const allAskTokens = estTokens(asks.reduce((n, a) => n + askCost(a), 0));
    const allCardTokens = estTokens(p.sessions.reduce((n, c) => n + cardCost(c, 'full'), 0));
    if (allAskTokens + allCardTokens > remaining) {
      fitted = true;
      // Requests are the primary analysis material: up to 40% of what is left, newest first.
      const askBudget = Math.floor(remaining * 0.4);
      let used = 0;
      keptAsks = [];
      for (let i = asks.length - 1; i >= 0; i--) {
        const c = estTokens(askCost(asks[i]));
        if (used + c > askBudget) break;
        keptAsks.unshift(asks[i]);
        used += c;
      }
      cardTiers = fitTiers(p.sessions, {
        tiers: CARD_TIERS,
        cost: cardCost,
        budgetTokens: remaining - used,
        guaranteeLast: 1,
      }).assigned;
    }
  }

  const L = [...spine];

  L.push('## Session cards');
  L.push('');
  const omitted = cardTiers.filter((t) => t === 'omit').length;
  if (fitted && omitted) {
    L.push(`_${omitted} older session(s) appear only in the table above to fit the size limit. Use \`session-extract view <id>\` for any of them._`);
    L.push('');
  }
  p.sessions.forEach((c, i) => {
    if (cardTiers[i] !== 'omit') L.push(...renderCard(c, cardTiers[i], relativeTo(p.folder)));
  });

  L.push('## Every request, in order');
  L.push('');
  if (keptAsks.length < asks.length) {
    L.push(`_Showing the ${keptAsks.length} most recent of ${asks.length} requests; the JSON beside this file has all of them._`);
    L.push('');
  }
  for (const a of keptAsks) L.push(askLine(a));
  L.push('');

  L.push(...footer);
  return {
    markdown: L.join('\n'),
    fit: { fitted, cards: Object.fromEntries(CARD_TIERS.map((t) => [t, cardTiers.filter((x) => x === t).length])), asks: { shown: keptAsks.length, total: asks.length } },
  };
}
