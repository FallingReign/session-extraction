/**
 * Fits rendered output to a token budget without losing what matters.
 *
 * Rules, in priority order:
 *  1. The spine (orientation and ledgers) is always present.
 *  2. The most recent items are guaranteed full fidelity.
 *  3. Remaining budget is spent backwards through history, raising every
 *     item one tier at a time (e.g. omitted → one line → brief → full), so
 *     older items get a readable minimum before newer ones get more detail.
 *
 * Omission is safe only because `session-extract search` and `turn` recover
 * anything omitted from the original session files on demand.
 */

export const CHARS_PER_TOKEN = 4;
export const estTokens = (chars) => Math.round(chars / CHARS_PER_TOKEN);

/**
 * Generic tier fitting.
 *   items         ordered oldest → newest
 *   tiers         lowest → highest, e.g. ['omit', 'digest', 'brief', 'full']
 *   cost(item, tier) rendered size in characters
 *   budgetTokens, baseTokens (already spent by the spine)
 *   guaranteeLast newest N items forced to the top tier
 * Returns { assigned: tier per item, usedTokens }.
 */
export function fitTiers(items, { tiers, cost, budgetTokens, baseTokens = 0, guaranteeLast = 0 }) {
  const top = tiers[tiers.length - 1];
  const assigned = items.map(() => tiers[0]);
  let used = baseTokens;

  const guaranteed = Math.min(guaranteeLast, items.length);
  for (let i = items.length - 1; i >= items.length - guaranteed; i--) {
    assigned[i] = top;
    used += estTokens(cost(items[i], top));
  }

  for (const target of tiers.slice(1)) {
    const rank = tiers.indexOf(target);
    for (let i = items.length - 1; i >= 0; i--) {
      const current = assigned[i];
      if (tiers.indexOf(current) >= rank) continue;
      const delta = estTokens(cost(items[i], target) - cost(items[i], current));
      if (used + delta > budgetTokens) continue;
      assigned[i] = target;
      used += delta;
    }
  }
  return { assigned, usedTokens: used, guaranteed };
}

const len = (s) => (s ? String(s).length : 0);

/** Approximate rendered size of one turn at a given fidelity tier. */
export function turnCost(turn, tier) {
  if (tier === 'omit') return 0;
  const head = 60;
  if (tier === 'digest') return head + Math.min(len(turn.ask), 140) + Math.min(len(turn.final), 140);
  if (tier === 'brief') return head + Math.min(len(turn.ask), 1200) + Math.min(len(turn.final), 1200) + 120;
  const notes = turn.notes.reduce((n, s) => n + len(s) + 4, 0);
  const reasoning = turn.reasoning.reduce((n, s) => n + len(s) + 3, 0);
  const actions = turn.actions.reduce((n, a) => n + len(a.line) + 6 + len(a.error), 0);
  return head + len(turn.ask) + len(turn.final) + notes + reasoning + actions;
}

const TURN_TIERS = ['omit', 'digest', 'brief', 'full'];

/** Assigns a tier to every turn of a session packet. */
export function planBudget(packet, { budgetTokens, spineTokens, guaranteeRecent = 3 }) {
  const turns = packet.turns;
  const tiers = new Map();
  const fullTokens = spineTokens + estTokens(turns.reduce((n, t) => n + turnCost(t, 'full'), 0));
  const tally = () => {
    const c = { full: 0, brief: 0, digest: 0, omit: 0 };
    for (const t of turns) c[tiers.get(t.turnId)]++;
    return c;
  };

  if (!budgetTokens || fullTokens <= budgetTokens) {
    for (const t of turns) tiers.set(t.turnId, 'full');
    return { tiers, fitted: false, fullTokens, budgetTokens, counts: tally(), guaranteed: turns.length };
  }

  const { assigned, usedTokens, guaranteed } = fitTiers(turns, {
    tiers: TURN_TIERS,
    cost: turnCost,
    budgetTokens,
    baseTokens: spineTokens,
    guaranteeLast: guaranteeRecent,
  });
  turns.forEach((t, i) => tiers.set(t.turnId, assigned[i]));
  return { tiers, fitted: true, fullTokens, budgetTokens, usedTokens, counts: tally(), guaranteed };
}
