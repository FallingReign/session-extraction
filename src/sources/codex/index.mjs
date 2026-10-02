/**
 * Codex session discovery.
 *
 * Codex writes rollouts to ~/.codex/sessions/YYYY/MM/DD/rollout-<stamp>-<uuid>.jsonl.
 * One thread can span several rollout files; continuation segments carry a
 * different UUID in their filename, so threads are grouped by the session_id
 * in each file's first record, not by name. Codex's own session_index.jsonl
 * is incomplete and is used only to supply titles.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readFirstLine } from '../../core/jsonl.mjs';

export const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
export const SESSIONS_ROOT = path.join(CODEX_HOME, 'sessions');

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const ROLLOUT_RE = new RegExp(`^rollout-(.+?)-(${UUID})(?:_(${UUID}))?\\.jsonl$`);

function parseRolloutName(basename) {
  const m = basename.match(ROLLOUT_RE);
  if (!m) return null;
  return { stamp: m[1], threadId: m[2].toLowerCase(), forkId: m[3] ? m[3].toLowerCase() : null };
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

function headerFor(file, stat) {
  const named = parseRolloutName(path.basename(file));
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
    file,
    bytes: stat.size,
    mtimeMs: stat.mtimeMs,
    startedAt: meta?.timestamp ?? null,
    updatedAt: new Date(stat.mtimeMs).toISOString(),
    cwd: meta?.cwd ?? null,
    originator: meta?.originator ?? null,
    model: meta?.base_instructions?.provenance?.model ?? null,
  };
}

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

export const link = (id) => `codex://threads/${id}`;

export function listFiles() {
  return walkRollouts().map((file) => {
    const s = fs.statSync(file);
    return { file, mtimeMs: s.mtimeMs, size: s.size };
  });
}

export const readHeader = (file, stat) => headerFor(file, stat);

/** Group rollout headers into threads. Titles come from Codex's own index. */
export function buildRefs(headers) {
  const titles = loadTitles();
  const byThread = new Map();
  for (const h of headers) {
    const group = byThread.get(h.threadId);
    if (group) group.push(h);
    else byThread.set(h.threadId, [h]);
  }
  return [...byThread.entries()].map(([id, segments]) => {
    segments.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const newest = segments[0];
    const oldest = segments[segments.length - 1];
    return {
      source: 'codex',
      id,
      title: titles.get(id) ?? null,
      cwd: newest.cwd,
      model: newest.model,
      originator: newest.originator,
      startedAt: oldest.startedAt,
      updatedAt: newest.updatedAt,
      mtimeMs: newest.mtimeMs,
      bytes: segments.reduce((n, s) => n + s.bytes, 0),
      segmentCount: segments.length,
      files: segments.map((s) => s.file),
      link: link(id),
    };
  });
}
