/**
 * Per-source session index, kept current incrementally.
 *
 * Adapters expose three steps:
 *   listFiles()               cheap: every session file with mtime and size
 *   readHeader(file, stat)    expensive: metadata read from one file
 *   buildRefs(headers)        group headers into SessionRefs
 *
 * Headers are cached by file path and reused while mtime and size are
 * unchanged, so the index is always current without re-reading every session:
 * only new or modified files are read again.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const CACHE_DIR =
  process.env.SESSION_EXTRACTION_HOME || path.join(os.homedir(), '.copilot', 'session-extraction');

const cachePath = (adapter) => path.join(CACHE_DIR, `headers-${adapter.id}.json`);

function readCache(adapter) {
  try {
    const c = JSON.parse(fs.readFileSync(cachePath(adapter), 'utf8'));
    return c.schema === adapter.indexSchema ? c.files : {};
  } catch {
    return {};
  }
}

export function loadIndex(adapter, { refresh = false, onProgress } = {}) {
  const previous = refresh ? {} : readCache(adapter);
  const listed = adapter.listFiles();
  const next = {};
  let read = 0;
  let changed = listed.length !== Object.keys(previous).length;

  for (const stat of listed) {
    const prior = previous[stat.file];
    if (prior && prior.mtimeMs === stat.mtimeMs && prior.size === stat.size) {
      next[stat.file] = prior;
      continue;
    }
    changed = true;
    read++;
    if (onProgress && read % 100 === 0) onProgress(read, listed.length);
    next[stat.file] = { mtimeMs: stat.mtimeMs, size: stat.size, header: adapter.readHeader(stat.file, stat) };
  }

  if (changed) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath(adapter), JSON.stringify({ schema: adapter.indexSchema, files: next }), 'utf8');
  }

  const headers = Object.values(next)
    .map((e) => e.header)
    .filter(Boolean);
  const sessions = adapter.buildRefs(headers).sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { source: adapter.id, sessions };
}
