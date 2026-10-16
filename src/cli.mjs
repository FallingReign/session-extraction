#!/usr/bin/env node
/**
 * session-extract — context-dense views of Codex and Copilot sessions.
 * Run with no arguments for usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { listSessions, openSession, findSessions, sessionsForFolder, normDir, ADAPTERS } from './core/sources.mjs';
import { CACHE_DIR } from './core/index-cache.mjs';
import { renderMarkdown } from './core/render-markdown.mjs';
import { estTokens } from './core/budget.mjs';
import { searchSession, replayTurn } from './core/retrieve.mjs';
import { buildProject } from './core/project.mjs';
import { renderProject } from './core/render-project.mjs';
import { human, ago } from './core/text.mjs';

// node:sqlite (used to read Copilot's per-session todo list) announces itself
// as experimental on first use; that notice is noise for this tool's users.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /sqlite/i.test(w.message)) return;
  console.error(String(w));
});

const HELP = `
  session-extract — context-dense views of Codex and Copilot sessions

  Find sessions
    list [--limit N]                  most recent sessions
    find <words>                      search titles, folders and ids
    here [--folder <dir>] [--nested]  sessions started in a folder (default: current)
    show <session>                    metadata for one session

  View one session
    view <session>                    write a packet: Markdown briefing + JSON data
    view --find "<words>" | --here | --recent N

  View every session for a project folder (Codex and Copilot together)
    project [folder]                  default: current folder, including subfolders
      --exact                         only sessions started in exactly this folder
      --since <when> --until <when>   limit by activity (YYYY-MM-DD, ISO time, or 7d / 12h)
      --last N                        only the N most recently active sessions

  View every session active in a time window, across all folders
    corpus --since <when> | --last N  same report as project, plus a folders table
      --exclude <folder>              skip sessions in a folder and its subfolders (repeatable)
      --packets                       also write each session's own view beside the report
      --packet-budget <tokens>        size of each session view (default 12000)

  Drill into the original transcript (nothing the packet drops is lost)
    search <session> "<text>" [--kind command] [--limit N] [--regex]
    turn <session> <n>                replay one turn in full, with output

  <session> is a codex://threads/<id> link, a Copilot session folder path, a
  session id, or the first 8+ characters of one.

  Options
    --source ${ADAPTERS.map((a) => a.id).join('|')}   limit to one tool (default: all)
    --budget <tokens>                 fit packets to a token budget (default 40000)
    --budget none                     render every turn in full
    --out <dir>                       where packets are written
    --stdout                          print the packet instead of writing files
    --refresh                         rebuild the session index first
`;

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  const set = (k, v) => {
    // A repeated flag keeps every value (e.g. --exclude a --exclude b).
    out.flags[k] = k in out.flags ? [].concat(out.flags[k], v) : v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) set(a.slice(2, eq), a.slice(eq + 1));
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) set(a.slice(2), argv[++i]);
      else set(a.slice(2), true);
    } else out._.push(a);
  }
  return out;
}

const flagStr = (v) => (Array.isArray(v) ? flagStr(v[v.length - 1]) : v === true || v === undefined ? null : String(v));
const flagList = (v) => [].concat(v ?? []).filter((x) => x !== true).map(String);

/**
 * A point in time from a flag: YYYY-MM-DD, an ISO timestamp, or a relative
 * age such as 7d or 12h. A bare date used as an upper bound means end of day.
 */
function parseWhen(value, { endOfDay = false } = {}) {
  if (!value) return null;
  const rel = /^(\d+)([dh])$/i.exec(value);
  if (rel) return Date.now() - Number(rel[1]) * (rel[2].toLowerCase() === 'd' ? 86400000 : 3600000);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`cannot read "${value}" as a time — use YYYY-MM-DD, an ISO timestamp, or an age like 7d / 12h`);
  return endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value) ? ms + 86400000 : ms;
}

/** Applies --since, --until and --last to a list of session refs. */
function selectWindow(refs, args) {
  const since = parseWhen(flagStr(args.flags.since));
  const until = parseWhen(flagStr(args.flags.until), { endOfDay: true });
  let out = refs;
  if (since !== null) out = out.filter((r) => Date.parse(r.updatedAt) >= since);
  if (until !== null) out = out.filter((r) => Date.parse(r.startedAt ?? r.updatedAt) <= until);
  if (args.flags.last) out = [...out].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, Number(flagStr(args.flags.last)));
  return {
    refs: out,
    window: {
      since: since !== null ? new Date(since).toISOString() : null,
      until: until !== null ? new Date(until).toISOString() : null,
    },
  };
}

function printTable(sessions, limit = 20) {
  const w = (s, n) => {
    const v = String(s ?? '');
    return (v.length >= n ? v.slice(0, n - 2) + '… ' : v).padEnd(n);
  };
  if (!sessions.length) {
    console.log('  (no matching sessions)');
    return;
  }
  console.log('  ' + w('#', 4) + w('SOURCE', 8) + w('ID', 10) + w('UPDATED', 10) + w('SIZE', 9) + w('TITLE', 40) + 'FOLDER');
  sessions.slice(0, limit).forEach((s, i) => {
    console.log(
      '  ' +
        w(i + 1, 4) +
        w(s.source, 8) +
        w(s.id.slice(0, 8), 10) +
        w(ago(s.updatedAt), 10) +
        w(human(s.bytes), 9) +
        w(s.title ?? '—', 40) +
        (s.cwd ?? '—')
    );
  });
  if (sessions.length > limit) console.log(`  …${sessions.length - limit} more`);
}

async function pick(sessions) {
  if (!process.stdin.isTTY) return sessions[0];
  printTable(sessions, 20);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question('\n  Pick a number (blank = 1): ', r));
  rl.close();
  const n = Number(answer.trim() || '1');
  return sessions[Math.max(1, Math.min(sessions.length, n)) - 1];
}

async function resolveOne(args, common) {
  const raw = args._[1];
  if (raw) {
    const opened = await openSession(raw, common);
    if (opened) return opened;
  }
  let candidates = null;
  if (args.flags.find || raw) candidates = findSessions(flagStr(args.flags.find) ?? raw, common);
  else if (args.flags.here) candidates = sessionsForFolder(flagStr(args.flags.here) ?? process.cwd(), common);
  else if (args.flags.recent) candidates = listSessions(common).slice(0, Number(flagStr(args.flags.recent) ?? 15));
  if (!candidates?.length) return null;
  const ref = candidates.length === 1 ? candidates[0] : await pick(candidates);
  return openSession(ref.id, { ...common, source: ref.source });
}

async function requireOne(args, common) {
  const opened = await resolveOne(args, common);
  if (!opened) {
    console.error(`\n  Could not identify a session from "${args._[1] ?? ''}". Try list, find or here.\n`);
    process.exit(1);
  }
  return opened;
}

function outputDir(args) {
  if (args.flags.out) return path.resolve(String(args.flags.out));
  return path.join(CACHE_DIR, 'packets');
}

const slugify = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || 'session';

function budgetFrom(args, flag = 'budget', fallback = 40000) {
  const v = flagStr(args.flags[flag]);
  if (v === 'none' || v === 'full') return null;
  return Number(v ?? fallback) || null;
}

/** Writes one session view (Markdown + JSON) and returns its paths. */
function writePacket(dir, ref, packet, budgetTokens) {
  const { markdown: md, budget } = renderMarkdown(packet, { budgetTokens });
  fs.mkdirSync(dir, { recursive: true });
  const base = `session-view-${ref.source}-${slugify(packet.session.title)}-${ref.id.slice(0, 8)}`;
  const mdPath = path.join(dir, `${base}.md`);
  const jsonPath = path.join(dir, `${base}.json`);
  fs.writeFileSync(mdPath, md, 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(packet, null, 2), 'utf8');
  return { md, budget, mdPath, jsonPath };
}

async function cmdView(args, common) {
  const { adapter, ref } = await requireOne(args, common);
  const budgetTokens = budgetFrom(args);
  process.stderr.write(`\n  Reading ${human(ref.bytes)} of ${adapter.label} session data…\n`);
  const started = Date.now();
  const packet = await adapter.condense(ref);

  if (args.flags.stdout) {
    process.stdout.write(renderMarkdown(packet, { budgetTokens }).markdown);
    return;
  }

  const { md, budget, mdPath, jsonPath } = writePacket(outputDir(args), ref, packet, budgetTokens);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const s = packet.stats;
  console.log('');
  console.log(`  Session   ${packet.session.title ?? ref.id}  (${adapter.label})`);
  console.log(`  Link      ${ref.link}`);
  console.log(`  Source    ${human(ref.bytes)} · ${s.sourceLines.toLocaleString()} records · read in ${elapsed}s`);
  console.log(`  Packet    ${human(md.length)} · ~${estTokens(md.length).toLocaleString()} tokens`);
  console.log(
    `  Content   ${s.turns} turns · ${s.commands} commands (${s.uniqueCommands} unique) · ${s.filesTouched} files · ${s.outstandingErrors} outstanding failure(s)`
  );
  if (budget.fitted) {
    console.log(
      `  Fitted    ${budget.counts.full} full / ${budget.counts.brief} brief / ${budget.counts.digest} one-line / ${budget.counts.omit} omitted (unabridged ~${budget.fullTokens.toLocaleString()} tokens)`
    );
  }
  console.log(`\n  → ${mdPath}\n  → ${jsonPath}\n`);
}

async function cmdSearch(args, common) {
  const { adapter, ref } = await requireOne(args, common);
  const query = args._.slice(2).join(' ');
  if (!query) {
    console.error('  usage: search <session> "<text>"');
    process.exit(2);
  }
  process.stderr.write(`  searching ${human(ref.bytes)} of transcript…\n`);
  const res = await searchSession(adapter, ref, query, {
    limit: Number(args.flags.limit ?? 15),
    radius: Number(args.flags.context ?? 400),
    regex: Boolean(args.flags.regex),
    kind: flagStr(args.flags.kind),
  });
  console.log(`\n  "${query}" — ${res.total} match(es) in ${res.scanned.toLocaleString()} records`);
  console.log(res.total > res.matches.length ? `  showing the ${res.matches.length} most recent\n` : '');
  for (const m of res.matches) {
    console.log(`  ── ${m.ts}  ${m.label}`);
    for (const line of m.excerpt.split('\n')) console.log('     ' + line);
    console.log('');
  }
}

async function cmdTurn(args, common) {
  const { adapter, ref } = await requireOne(args, common);
  const n = Number(args._[2]);
  if (!n) {
    console.error('  usage: turn <session> <n>');
    process.exit(2);
  }
  const res = await replayTurn(adapter, ref, n, { maxOutputChars: Number(args.flags.output ?? 4000) });
  if (!res.found) {
    console.error(`  turn ${n} not found (session has ${res.turnCount} turns)`);
    process.exit(1);
  }
  console.log(`\n  Turn ${n} of ${res.turnCount} — ${ref.title ?? ref.id}\n`);
  for (const e of res.events) {
    console.log(`  ── ${e.ts}  ${e.label}`);
    if (e.text) for (const l of e.text.split('\n')) console.log('     ' + l);
    for (const c of e.changes ?? []) {
      console.log(`     [${c.type}] ${c.path}`);
      for (const l of c.body.split('\n')) console.log('       | ' + l);
    }
    if (e.stderr) {
      console.log('     stderr:');
      for (const l of e.stderr.split('\n')) console.log('       ' + l);
    }
    if (e.output) for (const l of e.output.split('\n')) console.log('       ' + l);
    console.log('');
  }
}

/** Condenses the selected sessions, renders the report, writes both files and prints a receipt. */
async function writeReport(args, { folder, refs, window, base, heading }) {
  const total = refs.reduce((n, r) => n + r.bytes, 0);
  process.stderr.write(`\n  Reading ${refs.length} session(s), ${human(total)} of session data…\n`);
  const started = Date.now();
  const dir = outputDir(args);
  const packetDir = args.flags.packets ? path.join(dir, `${base}-sessions`) : null;
  const packetBudget = budgetFrom(args, 'packet-budget', 12000);
  const project = await buildProject(folder, refs, {
    onSession: (ref, i, n) => process.stderr.write(`\r  ${i + 1}/${n} ${ref.source} ${ref.id.slice(0, 8)} (${human(ref.bytes)})        `),
    onPacket: packetDir ? (ref, packet) => writePacket(packetDir, ref, packet, packetBudget).mdPath : undefined,
  });
  if (window) project.window = window;
  process.stderr.write('\r' + ' '.repeat(60) + '\r');
  const { markdown: md, fit } = renderProject(project, { budgetTokens: budgetFrom(args) });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (args.flags.stdout) {
    process.stdout.write(md);
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  const mdPath = path.join(dir, `${base}.md`);
  const jsonPath = path.join(dir, `${base}.json`);
  fs.writeFileSync(mdPath, md, 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(project, null, 2), 'utf8');

  const t = project.totals;
  console.log('');
  console.log(`  ${heading}`);
  console.log(`  Sessions  ${t.sessions} (${Object.entries(t.bySource).map(([s, n]) => `${n} ${s}`).join(', ')}) · read in ${elapsed}s`);
  console.log(`  Activity  ${t.turns} turns · ${t.commands} commands · ${t.filesChanged} files changed · ${t.outstandingFailures} outstanding failure(s)`);
  console.log(`  Report    ${human(md.length)} · ~${estTokens(md.length).toLocaleString()} tokens`);
  if (fit.fitted) {
    console.log(`  Fitted    cards ${fit.cards.full} full / ${fit.cards.brief} brief / ${fit.cards.omit} table-only · requests ${fit.asks.shown} of ${fit.asks.total}`);
  }
  console.log(`\n  → ${mdPath}\n  → ${jsonPath}`);
  if (packetDir) console.log(`  → ${packetDir}  (${t.sessions} session views, ~${(packetBudget ?? 'full').toLocaleString()} tokens max each)`);
  console.log('');
}

async function cmdProject(args, common) {
  const folder = path.resolve(args._[1] ?? flagStr(args.flags.folder) ?? process.cwd());
  const { refs } = selectWindow(sessionsForFolder(folder, { ...common, nested: !args.flags.exact }), args);
  if (!refs.length) {
    console.error(`\n  No sessions found for ${folder}${args.flags.exact ? '' : ' (including subfolders)'}.\n`);
    process.exit(1);
  }
  await writeReport(args, {
    folder,
    refs,
    base: `project-view-${slugify(path.basename(folder))}-${new Date().toISOString().slice(0, 10)}`,
    heading: `Project   ${folder}`,
  });
}

async function cmdCorpus(args, common) {
  if (!args.flags.since && !args.flags.last) {
    console.error('\n  corpus needs --since <when> or --last N (e.g. --since 7d). It spans every folder, so an unbounded run would read all history.\n');
    process.exit(2);
  }
  const excluded = flagList(args.flags.exclude).map((e) => path.resolve(e));
  const ex = excluded.map(normDir);
  const inExcluded = (cwd) => {
    if (!cwd) return false;
    const c = normDir(cwd);
    return ex.some((e) => c === e || c.startsWith(e + path.sep));
  };
  const all = listSessions(common).filter((r) => !inExcluded(r.cwd));
  const { refs, window } = selectWindow(all, args);
  if (!refs.length) {
    console.log(`\n  corpus: 0 sessions active ${window.since ? `since ${window.since}` : 'in the window'}${excluded.length ? ` outside ${excluded.length} excluded folder(s)` : ''}.\n`);
    return;
  }
  await writeReport(args, {
    folder: null,
    refs,
    window: { ...window, excluded },
    base: `corpus-view-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`,
    heading: `Corpus    ${window.since ?? 'start'} → ${window.until ?? 'now'}${excluded.length ? ` · ${excluded.length} folder(s) excluded` : ''}`,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || cmd === 'help' || args.flags.help) {
    console.log(HELP);
    return;
  }

  let progressed = false;
  const common = {
    source: flagStr(args.flags.source),
    refresh: Boolean(args.flags.refresh),
    onProgress: (adapter, n, total) => {
      progressed = true;
      process.stderr.write(`\r  indexing ${adapter.label} ${n}/${total}…`);
    },
  };
  const clearProgress = () => {
    if (progressed) process.stderr.write('\r' + ' '.repeat(50) + '\r');
    progressed = false;
  };

  switch (cmd) {
    case 'list': {
      const all = listSessions(common);
      clearProgress();
      console.log(`\n  ${all.length} sessions\n`);
      printTable(all, Number(args.flags.limit ?? 20));
      return;
    }
    case 'find': {
      const q = args._.slice(1).join(' ');
      const hits = findSessions(q, common);
      clearProgress();
      console.log(`\n  "${q}" — ${hits.length} hit(s)\n`);
      printTable(hits, Number(args.flags.limit ?? 20));
      return;
    }
    case 'here': {
      const folder = flagStr(args.flags.folder) ?? args._[1] ?? process.cwd();
      const hits = sessionsForFolder(folder, { ...common, nested: Boolean(args.flags.nested) });
      clearProgress();
      console.log(`\n  ${hits.length} session(s) in ${path.resolve(folder)}\n`);
      printTable(hits, Number(args.flags.limit ?? 50));
      return;
    }
    case 'show': {
      const { ref } = await requireOne(args, common);
      clearProgress();
      console.log(JSON.stringify(ref, null, 2));
      return;
    }
    case 'view':
      return cmdView(args, common);
    case 'project':
      return cmdProject(args, common);
    case 'corpus':
      return cmdCorpus(args, common);
    case 'search':
      return cmdSearch(args, common);
    case 'turn':
      return cmdTurn(args, common);
    default:
      console.error(`  unknown command "${cmd}"`);
      console.log(HELP);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error('\n  session-extract failed:', err?.message ?? err);
  if (process.env.DEBUG) console.error(err?.stack);
  process.exit(1);
});
