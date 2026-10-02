/**
 * Per-source session index cache.
 *
 * Building an index means reading one header per session, which takes a few
 * seconds across hundreds of sessions. The result is cached per source and
 * rebuilt when the adapter's fingerprint (a cheap count of session files)
 * changes or when a refresh is requested.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const CACHE_DIR = process.env.SESSION_EXTRACTION_HOME || path.join(os.homedir(), '.copilot', 'session-extraction');
const MAX_AGE_MS = 5 * 60 * 1000;

const indexPath = (adapter) => path.join(CACHE_DIR, `index-${adapter.id}.json`);

export function loadIndex(adapter, { refresh = false, onProgress } = {}) {
  const file = indexPath(adapter);
  if (!refresh && fs.existsSync(file)) {
    try {
      const idx = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (idx.schema === adapter.indexSchema) {
        if (Date.now() - Date.parse(idx.builtAt) < MAX_AGE_MS) return idx;
        if (adapter.fingerprint() === idx.fingerprint) return idx;
      }
    } catch {
      /* rebuild */
    }
  }
  const sessions = adapter.buildIndex({ onProgress });
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const idx = {
    source: adapter.id,
    schema: adapter.indexSchema,
    builtAt: new Date().toISOString(),
    fingerprint: adapter.fingerprint(),
    sessions,
  };
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(idx, null, 2), 'utf8');
  return idx;
}
