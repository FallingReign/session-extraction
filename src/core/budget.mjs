/**
 * Fits a packet to a token budget without losing what matters.
 *
 * Rules, in priority order:
 *  1. The spine (orientation, plan, outstanding failures, file ledger) is
 *     always present — it is what a resuming agent acts on.
 *  2. The most recent turns are guaranteed full fidelity, because resuming
 *     means continuing from the end.
 *  3. Remaining budget is spent backwards through history: brief, then a
 *     one-line digest, then omitted entirely.
 *
 * Omission is safe only because `codex-migrate search` and `codex-migrate turn`
 * can recover any omitted detail from the original rollout on demand.
 */

export const CHARS_PER_TOKEN = 4;
export const estTokens = (chars) => Math.round(chars / CHARS_PER_TOKEN);

const len = (s) => (s ? String(s).length : 0);

/** Approximate rendered size of one turn at a given fidelity tier. */
export function turnCost(turn, tier) {
  if (tier === 'omit') return 0;
  const head = 60;
  if (tier === 'digest') {
    return head + Math.min(len(turn.ask), 140) + Math.min(len(turn.final), 140);
  }
  if (tier === 'brief') {
    return head + Math.min(len(turn.ask), 1200) + Math.min(len(turn.final), 1200) + 120;
  }
  const notes = turn.notes.reduce((n, s) => n + len(s) + 4, 0);
  const reasoning = turn.reasoning.reduce((n, s) => n + len(s) + 3, 0);
  const actions = turn.actions.reduce((n, a) => n + len(a.line) + 6 + len(a.error), 0);
  return head + len(turn.ask) + len(turn.final) + notes + reasoning + actions;
}

const TIERS = ['omit', 'digest', 'brief', 'full'];

/**
 * Assigns a tier to every turn so the packet lands near the budget.
 */
export function planBudget(packet, { budgetTokens, spineTokens, guaranteeRecent = 3 }) {
  const turns = packet.turns;
  const tiers = new Map();
  const fullChars = turns.reduce((n, t) => n + turnCost(t, 'full'), 0);
  const fullTokens = spineTokens + estTokens(fullChars);
  const tally = () => {
    const c = { full: 0, brief: 0, digest: 0, omit: 0 };
    for (const t of turns) c[tiers.get(t.turnId)]++;
    return c;
  };

  if (!budgetTokens || fullTokens <= budgetTokens) {
    for (const t of turns) tiers.set(t.turnId, 'full');
    return { tiers, fitted: false, fullTokens, budgetTokens, counts: tally(), guaranteed: turns.length };
  }

  for (const t of turns) tiers.set(t.turnId, 'omit');
  let used = spineTokens;

  // Guarantee the newest turns in full — resuming happens from the end.
  const guaranteed = Math.min(guaranteeRecent, turns.length);
  for (let i = turns.length - 1; i >= turns.length - guaranteed; i--) {
    const t = turns[i];
    tiers.set(t.turnId, 'full');
    used += estTokens(turnCost(t, 'full'));
  }

  // Then walk backwards raising each remaining turn as far as the budget allows.
  const raise = (target) => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      const current = tiers.get(t.turnId);
      if (TIERS.indexOf(current) >= TIERS.indexOf(target)) continue;
      const delta = estTokens(turnCost(t, target) - turnCost(t, current));
      if (used + delta > budgetTokens) continue;
      tiers.set(t.turnId, target);
      used += delta;
    }
  };
  raise('digest');
  raise('brief');
  raise('full');

  return { tiers, fitted: true, fullTokens, budgetTokens, usedTokens: used, counts: tally(), guaranteed };
}
