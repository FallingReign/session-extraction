/**
 * Source registry: the one place that knows which adapters exist and how to
 * turn whatever the user supplied (link, id, id prefix, session folder path,
 * words) into sessions.
 *
 * Every adapter exposes the same surface:
 *   id, label, indexSchema
 *   listFiles() / readHeader(file, stat) / buildRefs(headers)
 *                              incremental discovery (see core/index-cache.mjs)
 *   claim(raw)                 -> SessionRef | null for inputs only it understands
 *   filesFor(ref)              -> raw files, oldest first
 *   condense(ref, limits)      -> packet (see core/packet-builder.mjs)
 *   reader(), turnIdInLine     retrieval (see core/retrieve.mjs)
 *
 * SessionRef: { source, id, title, cwd, model, originator, startedAt,
 *               updatedAt, mtimeMs, bytes, segmentCount, files, link, ... }
 */
import path from 'node:path';
import codex from '../sources/codex/adapter.mjs';
import copilot from '../sources/copilot/adapter.mjs';
import { loadIndex } from './index-cache.mjs';
import { extractUuid } from './text.mjs';

export const ADAPTERS = [codex, copilot];

export const adapterFor = (id) => ADAPTERS.find((a) => a.id === id) ?? null;

function selected(source) {
  if (!source || source === 'all') return ADAPTERS;
  const a = adapterFor(source);
  if (!a) throw new Error(`unknown source "${source}" — expected one of: ${ADAPTERS.map((x) => x.id).join(', ')}`);
  return [a];
}

/** All sessions from the selected sources, newest first. */
export function listSessions({ source, refresh = false, onProgress } = {}) {
  const all = [];
  for (const adapter of selected(source)) {
    const idx = loadIndex(adapter, {
      refresh,
      onProgress: onProgress && ((n, total) => onProgress(adapter, n, total)),
    });
    all.push(...idx.sessions);
  }
  return all.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Resolve one session from a link, UUID, short id prefix, or adapter-specific path. */
export async function openSession(raw, opts = {}) {
  for (const adapter of selected(opts.source)) {
    const ref = adapter.claim?.(raw);
    if (ref) return { adapter, ref };
  }
  const id = extractUuid(raw);
  const prefix = !id && /^[0-9a-f-]{6,}$/i.test(String(raw ?? '').trim()) ? String(raw).trim().toLowerCase() : null;
  if (!id && !prefix) return null;
  const hits = listSessions(opts).filter((ref) => (id ? ref.id === id : ref.id.startsWith(prefix)));
  if (hits.length > 1) {
    throw new Error(`"${raw}" matches ${hits.length} sessions — use more characters of the id`);
  }
  return hits[0] ? { adapter: adapterFor(hits[0].source), ref: hits[0] } : null;
}

/** Word search over titles, folders and ids. Every word must match. */
export function findSessions(query, opts = {}) {
  const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  return listSessions(opts)
    .map((ref) => {
      const hay = `${ref.title ?? ''} ${ref.cwd ?? ''} ${ref.id}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (!hay.includes(term)) return null;
        score += (ref.title ?? '').toLowerCase().includes(term) ? 2 : 1;
      }
      return { ref, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || b.ref.mtimeMs - a.ref.mtimeMs)
    .map((r) => r.ref);
}

const normDir = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

/** Sessions whose working directory is the folder, or (with nested) inside it. */
export function sessionsForFolder(folder, { nested = false, ...opts } = {}) {
  const target = normDir(folder);
  return listSessions(opts).filter((ref) => {
    if (!ref.cwd) return false;
    const cwd = normDir(ref.cwd);
    return cwd === target || (nested && cwd.startsWith(target + path.sep));
  });
}
