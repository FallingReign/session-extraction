#!/usr/bin/env node
/**
 * session-extract — context-dense views of Codex and Copilot sessions.
 * Run with no arguments for usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { listSessions, openSession, findSessions, sessionsForFolder, ADAPTERS } from './core/sources.mjs';
import { CACHE_DIR } from './core/index-cache.mjs';
import { renderMarkdown } from './core/render-markdown.mjs';
import { estTokens } from './core/budget.mjs';
import { searchSession, replayTurn } from './core/retrieve.mjs';
import { human, ago } from './core/text.mjs';

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

  Drill into the original transcript (nothing the packet drops is lost)
    search <session> "<text>" [--kind command] [--limit N] [--regex]
    turn <session> <n>                replay one turn in full, with output

  <session> is a codex://threads/<id> link, a session id, or the first 8+
  characters of one.

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
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out.flags[a.slice(2)] = argv[++i];
      else out.flags[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

const flagStr = (v) => (v === true || v === undefined ? null : String(v));

function printTable(sessions, limit = 20) {
  const w = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
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

function budgetFrom(args) {
  const v = args.flags.budget;
  if (v === 'none' || v === 'full') return null;
  return Number(v ?? 40000) || null;
}

async function cmdView(args, common) {
  const { adapter, ref } = await requireOne(args, common);
  const budgetTokens = budgetFrom(args);
  process.stderr.write(`\n  Reading ${human(ref.bytes)} of ${adapter.label} session data…\n`);
  const started = Date.now();
  const packet = await adapter.condense(ref);
  const { markdown: md, budget } = renderMarkdown(packet, { budgetTokens });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (args.flags.stdout) {
    process.stdout.write(md);
    return;
  }

  const dir = outputDir(args);
  fs.mkdirSync(dir, { recursive: true });
  const base = `session-view-${ref.source}-${slugify(packet.session.title)}-${ref.id.slice(0, 8)}`;
  const mdPath = path.join(dir, `${base}.md`);
  const jsonPath = path.join(dir, `${base}.json`);
  fs.writeFileSync(mdPath, md, 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(packet, null, 2), 'utf8');

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
