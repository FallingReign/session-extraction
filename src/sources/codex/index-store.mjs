import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
export const SESSIONS_ROOT = path.join(CODEX_HOME, 'sessions');
export const CACHE_DIR = path.join(os.homedir(), '.copilot', 'codex-migration');
export const INDEX_PATH = path.join(CACHE_DIR, 'index.json');

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const ROLLOUT_RE = new RegExp(`^rollout-(.+?)-(${UUID})(?:_(${UUID}))?\\.jsonl$`);

export function parseRolloutName(basename) {
  const m = basename.match(ROLLOUT_RE);
  if (!m) return null;
  return { stamp: m[1], threadId: m[2].toLowerCase(), forkId: m[3] ? m[3].toLowerCase() : null };
}

/** Extract a thread id from a raw arg: uuid, codex://threads/<uuid>, or a file path. */
export function extractThreadId(input) {
  if (!input) return null;
  const m = String(input).match(new RegExp(UUID));
  return m ? m[0].toLowerCase() : null;
}

export function walkRollouts(dir = SESSIONS_ROOT, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkRollouts(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/** Read just enough bytes off the front of the file to parse the session_meta line. */
function readFirstLine(file, chunkSize = 65536) {
  const fd = fs.openSync(file, 'r');
  try {
    let buf = Buffer.alloc(0);
    let pos = 0;
    for (let i = 0; i < 16; i++) {
      const chunk = Buffer.alloc(chunkSize);
      const read = fs.readSync(fd, chunk, 0, chunkSize, pos);
      if (read === 0) break;
      pos += read;
      buf = Buffer.concat([buf, chunk.subarray(0, read)]);
      const nl = buf.indexOf(0x0a);
      if (nl !== -1) return buf.subarray(0, nl).toString('utf8');
    }
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function headerFor(file) {
  const base = path.basename(file);
  const named = parseRolloutName(base);
  const stat = fs.statSync(file);
  let meta = null;
  try {
    const rec = JSON.parse(readFirstLine(file));
    if (rec?.type === 'session_meta') meta = rec.payload;
  } catch {
    /* corrupt or unusual header; fall back to filename */
  }
  const threadId = (meta?.session_id || meta?.id || named?.threadId || '').toLowerCase();
  if (!threadId) return null;
  return {
    threadId,
    forkId: named?.forkId ?? null,
    file,
    bytes: stat.size,
    mtimeMs: stat.mtimeMs,
    startedAt: meta?.timestamp ?? null,
    updatedAt: new Date(stat.mtimeMs).toISOString(),
    cwd: meta?.cwd ?? null,
    originator: meta?.originator ?? null,
    source: meta?.source ?? null,
    threadSource: meta?.thread_source ?? null,
    cliVersion: meta?.cli_version ?? null,
    model: meta?.base_instructions?.provenance?.model ?? null,
  };
}

/** Titles come from ~/.codex/session_index.jsonl. It is incomplete, so it only enriches. */
function loadTitles() {
  const p = path.join(CODEX_HOME, 'session_index.jsonl');
  const titles = new Map();
  if (!fs.existsSync(p)) return titles;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o.id) titles.set(String(o.id).toLowerCase(), o.thread_name || null);
    } catch {
      /* skip */
    }
  }
  return titles;
}

export function buildIndex({ onProgress } = {}) {
  const files = walkRollouts();
  const titles = loadTitles();
  const byThread = new Map();
  let scanned = 0;
  for (const f of files) {
    scanned++;
    if (onProgress && scanned % 100 === 0) onProgress(scanned, files.length);
    const h = headerFor(f);
    if (!h) continue;
    h.title = titles.get(h.threadId) ?? null;
    const prior = byThread.get(h.threadId);
    if (prior) prior.segments.push(h);
    else byThread.set(h.threadId, { threadId: h.threadId, segments: [h] });
  }
  const threads = [...byThread.values()].map((t) => {
    t.segments.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const newest = t.segments[0];
    const oldest = t.segments[t.segments.length - 1];
    return {
      threadId: t.threadId,
      title: newest.title,
      cwd: newest.cwd,
      model: newest.model,
      originator: newest.originator,
      startedAt: oldest.startedAt,
      updatedAt: newest.updatedAt,
      mtimeMs: newest.mtimeMs,
      bytes: t.segments.reduce((n, s) => n + s.bytes, 0),
      segmentCount: t.segments.length,
      files: t.segments.map((s) => s.file),
      deepLink: `codex://threads/${t.threadId}`,
    };
  });
  threads.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { builtAt: new Date().toISOString(), sessionsRoot: SESSIONS_ROOT, fileCount: files.length, threads };
}

export function saveIndex(index) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), 'utf8');
  return INDEX_PATH;
}

export function loadIndex({ refresh = false, maxAgeMs = 5 * 60 * 1000, onProgress } = {}) {
  if (!refresh && fs.existsSync(INDEX_PATH)) {
    try {
      const idx = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
      const age = Date.now() - Date.parse(idx.builtAt);
      if (age < maxAgeMs) return idx;
      if (walkRollouts().length === idx.fileCount) return idx;
    } catch {
      /* rebuild */
    }
  }
  const idx = buildIndex({ onProgress });
  saveIndex(idx);
  return idx;
}

export function findByThreadId(index, raw) {
  const id = extractThreadId(raw);
  if (!id) return null;
  return index.threads.find((t) => t.threadId === id) ?? null;
}

export function searchThreads(index, query) {
  const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  return index.threads
    .map((t) => {
      const hay = `${t.title ?? ''} ${t.cwd ?? ''} ${t.threadId}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (!hay.includes(term)) return null;
        score += (t.title ?? '').toLowerCase().includes(term) ? 2 : 1;
      }
      return { thread: t, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || b.thread.mtimeMs - a.thread.mtimeMs)
    .map((r) => r.thread);
}

export function threadsForCwd(index, cwd) {
  const target = path.resolve(cwd).toLowerCase();
  return index.threads.filter((t) => t.cwd && path.resolve(t.cwd).toLowerCase() === target);
}
