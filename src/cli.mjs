#!/usr/bin/env node
/**
 * codex-migrate — turn a Codex session into a compact handoff packet
 * that a Copilot agent can absorb without reading the raw rollout.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import {
  loadIndex,
  findByThreadId,
  searchThreads,
  threadsForCwd,
  INDEX_PATH,
  CACHE_DIR,
} from './lib/index-store.mjs';
import { condenseThread } from './lib/condense.mjs';
import { renderMarkdown } from './lib/render-markdown.mjs';
import { searchThread, replayTurn } from './lib/retrieve.mjs';

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

const human = (n) =>
  n > 1e9 ? `${(n / 1e9).toFixed(2)}GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`;

const ago = (iso) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

// Rough but stable: ~4 chars per token for English + code.
const estTokens = (s) => Math.round(s.length / 4);

function printTable(threads, limit = 20) {
  const w = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
  if (!threads.length) {
    console.log('  (no matching sessions)');
    return;
  }
  console.log('  ' + w('#', 4) + w('UPDATED', 10) + w('SIZE', 9) + w('TITLE', 40) + 'CWD');
  threads.slice(0, limit).forEach((t, i) => {
    console.log('  ' + w(i + 1, 4) + w(ago(t.updatedAt), 10) + w(human(t.bytes), 9) + w(t.title ?? '—', 40) + (t.cwd ?? '—'));
  });
  if (threads.length > limit) console.log(`  …${threads.length - limit} more`);
}

async function pick(threads) {
  if (!process.stdin.isTTY) return threads[0];
  printTable(threads, 20);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question('\n  Pick a number (blank = 1): ', r));
  rl.close();
  const n = Number(answer.trim() || '1');
  return threads[Math.max(1, Math.min(threads.length, n)) - 1];
}

/** Resolve the thread the user meant from whatever they gave us. */
async function resolveThread(index, args) {
  const positional = args._[1];
  if (positional) {
    const direct = findByThreadId(index, positional);
    if (direct) return direct;
  }
  if (args.flags.find || (positional && !findByThreadId(index, positional))) {
    const q = args.flags.find === true ? positional : (args.flags.find ?? positional);
    const hits = searchThreads(index, q);
    if (!hits.length) return null;
    if (hits.length === 1) return hits[0];
    console.log(`\n  "${q}" matched ${hits.length} sessions:\n`);
    return pick(hits);
  }
  if (args.flags.here) {
    const hits = threadsForCwd(index, args.flags.here === true ? process.cwd() : args.flags.here);
    if (!hits.length) return null;
    return hits.length === 1 ? hits[0] : pick(hits);
  }
  if (args.flags.recent) {
    const n = Number(args.flags.recent === true ? 15 : args.flags.recent);
    console.log(`\n  ${n} most recent Codex sessions:\n`);
    return pick(index.threads.slice(0, n));
  }
  return null;
}

function outputDir(args) {
  if (args.flags.out) return path.resolve(String(args.flags.out));
  const sessionDir = process.env.COPILOT_SESSION_FILES || process.env.COPILOT_SESSION_DIR;
  if (sessionDir) return path.join(sessionDir, sessionDir.endsWith('files') ? '' : 'files');
  return path.join(CACHE_DIR, 'packets');
}

const HELP = `
  codex-migrate — condense a Codex session into a Copilot handoff packet

  Selecting a session
    codex-migrate resume codex://threads/<uuid>     by deep link
    codex-migrate resume <uuid>                     by thread id
    codex-migrate resume --find "login page"        fuzzy title/path search
    codex-migrate resume --here                     sessions started in this directory
    codex-migrate resume --recent 15                pick from the most recent N

  Options
    --budget <tokens>            fit the packet to a token budget (default 40000)
    --budget none                no budget; render every turn in full
    --out <dir>                  where to write (default: Copilot session files/)
    --stdout                     print the packet instead of writing it
    --refresh                    rebuild the session index first

  Drilling back into the full transcript (nothing is ever lost)
    codex-migrate search <session> "<text>"   find anything, incl. command output
    codex-migrate search <session> "<text>" --kind command --limit 5
    codex-migrate turn <session> <n>          replay one turn at full fidelity

  Other commands
    codex-migrate list [--limit N]      recent sessions
    codex-migrate find <query>          search sessions
    codex-migrate here                  sessions for the current directory
    codex-migrate show <id|link>        details for one session
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] ?? 'help';
  if (cmd === 'help' || args.flags.help) {
    console.log(HELP);
    return;
  }

  let progressed = false;
  const index = loadIndex({
    refresh: Boolean(args.flags.refresh),
    onProgress: (n, total) => {
      progressed = true;
      process.stderr.write(`\r  indexing ${n}/${total}…`);
    },
  });
  if (progressed) process.stderr.write('\r' + ' '.repeat(40) + '\r');

  if (cmd === 'list') {
    console.log(`\n  ${index.threads.length} Codex threads / ${index.fileCount} rollout files`);
    console.log(`  index: ${INDEX_PATH}\n`);
    printTable(index.threads, Number(args.flags.limit ?? 20));
    return;
  }
  if (cmd === 'find') {
    const q = args._.slice(1).join(' ');
    const hits = searchThreads(index, q);
    console.log(`\n  "${q}" — ${hits.length} hit(s)\n`);
    printTable(hits, Number(args.flags.limit ?? 20));
    return;
  }
  if (cmd === 'here') {
    const hits = threadsForCwd(index, args.flags.cwd || process.cwd());
    console.log(`\n  ${hits.length} session(s) for ${path.resolve(args.flags.cwd || process.cwd())}\n`);
    printTable(hits, Number(args.flags.limit ?? 20));
    return;
  }
  if (cmd === 'show') {
    const t = findByThreadId(index, args._[1]);
    if (!t) {
      console.error(`  no session for "${args._[1]}"`);
      process.exit(1);
    }
    console.log(JSON.stringify(t, null, 2));
    return;
  }
  if (cmd === 'search') {
    const thread = findByThreadId(index, args._[1]) ?? (searchThreads(index, args._[1])[0] ?? null);
    if (!thread) {
      console.error(`  no session for "${args._[1]}"`);
      process.exit(1);
    }
    const query = args._.slice(2).join(' ');
    if (!query) {
      console.error('  usage: codex-migrate search <session> "<text>"');
      process.exit(2);
    }
    process.stderr.write(`  searching ${human(thread.bytes)} of transcript…\n`);
    const res = await searchThread(thread, query, {
      limit: Number(args.flags.limit ?? 15),
      radius: Number(args.flags.context ?? 400),
      regex: Boolean(args.flags.regex),
      kind: args.flags.kind && args.flags.kind !== true ? String(args.flags.kind) : null,
    });
    console.log(`\n  "${query}" — ${res.total} match(es) in ${res.scanned.toLocaleString()} records`);
    if (res.total > res.matches.length) {
      console.log(`  showing the ${res.matches.length} most recent\n`);
    } else console.log('');
    for (const m of res.matches) {
      console.log(`  ── ${m.ts}  ${m.label}`);
      for (const line of m.excerpt.split('\n')) console.log('     ' + line);
      console.log('');
    }
    return;
  }

  if (cmd === 'turn') {
    const thread = findByThreadId(index, args._[1]) ?? (searchThreads(index, args._[1])[0] ?? null);
    if (!thread) {
      console.error(`  no session for "${args._[1]}"`);
      process.exit(1);
    }
    const n = Number(args._[2]);
    if (!n) {
      console.error('  usage: codex-migrate turn <session> <turn number>');
      process.exit(2);
    }
    const res = await replayTurn(thread, n, { maxOutputChars: Number(args.flags.output ?? 4000) });
    if (!res.found) {
      console.error(`  turn ${n} not found (session has ${res.turnCount} turns)`);
      process.exit(1);
    }
    console.log(`\n  Turn ${n} of ${res.turnCount} — ${thread.title ?? thread.threadId}\n`);
    for (const e of res.events) {
      console.log(`  ── ${e.ts}  ${e.label}`);
      if (e.text) for (const l of e.text.split('\n')) console.log('     ' + l);
      if (e.changes) {
        for (const c of e.changes) {
          console.log(`     [${c.type}] ${c.path}`);
          for (const l of c.body.split('\n')) console.log('       | ' + l);
        }
      }
      if (e.stderr) {
        console.log('     stderr:');
        for (const l of e.stderr.split('\n')) console.log('       ' + l);
      }
      if (e.output) for (const l of e.output.split('\n')) console.log('       ' + l);
      console.log('');
    }
    return;
  }

  if (cmd !== 'resume') {
    console.error(`  unknown command "${cmd}"`);
    console.log(HELP);
    process.exit(2);
  }

  const thread = await resolveThread(index, args);
  if (!thread) {
    console.error('\n  Could not identify a session. Try --recent 15, --here, or --find "<words>".\n');
    process.exit(1);
  }

  const depth = String(args.flags.depth ?? 'standard');
  const budgetTokens =
    args.flags.budget === 'none' || args.flags.budget === 'full'
      ? null
      : Number(args.flags.budget ?? (depth === 'lean' ? 12000 : depth === 'full' ? 0 : 40000)) || null;

  process.stderr.write(`\n  Reading ${human(thread.bytes)} across ${thread.files.length} file(s)…\n`);
  const started = Date.now();
  // The JSON packet stays at full fidelity; the renderer is what trims.
  const packet = await condenseThread(thread, { keepReasoning: true });
  const { markdown: md, budget } = renderMarkdown(packet, { budgetTokens });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (args.flags.stdout) {
    process.stdout.write(md);
    return;
  }

  const dir = outputDir(args);
  fs.mkdirSync(dir, { recursive: true });
  const slug = (packet.thread.title ?? 'codex-session')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || 'codex-session';
  const base = `codex-handoff-${slug}-${thread.threadId.slice(0, 8)}`;
  const mdPath = path.join(dir, `${base}.md`);
  const jsonPath = path.join(dir, `${base}.json`);
  fs.writeFileSync(mdPath, md, 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(packet, null, 2), 'utf8');

  const ratio = thread.bytes / Math.max(1, md.length);
  console.log('');
  console.log(`  Session   ${packet.thread.title ?? thread.threadId}`);
  console.log(`  Deep link ${thread.deepLink}`);
  console.log(`  Source    ${human(thread.bytes)} · ${packet.stats.sourceLines.toLocaleString()} records · read in ${elapsed}s`);
  console.log(`  Packet    ${human(md.length)} · ~${estTokens(md).toLocaleString()} tokens · ${ratio.toFixed(0)}× smaller`);
  console.log(
    `  Content   ${packet.stats.turns} turns · ${packet.stats.commands} commands (${packet.stats.uniqueCommands} unique) · ${packet.stats.filesTouched} files · ${packet.stats.outstandingErrors} outstanding failure(s)`
  );
  if (budget.fitted) {
    console.log(
      `  Fitted    ${budget.counts.full} full / ${budget.counts.brief} brief / ${budget.counts.digest} one-line turns (unabridged ~${budget.fullTokens.toLocaleString()} tokens)`
    );
  }
  console.log('');
  console.log(`  → ${mdPath}`);
  console.log(`  → ${jsonPath}`);
  console.log('');
  if (budget.fitted) {
    console.log('  Nothing was lost. Drill back into the original transcript with:');
    console.log(`    codex-migrate search ${thread.threadId.slice(0, 8)} "<text>"`);
    console.log(`    codex-migrate turn   ${thread.threadId.slice(0, 8)} <turn number>`);
    console.log('');
  }
}

main().catch((err) => {
  console.error('\n  codex-migrate failed:', err?.stack ?? err);
  process.exit(1);
});
