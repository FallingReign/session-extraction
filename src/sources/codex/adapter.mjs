/** Codex source adapter. See core/sources.mjs for the adapter contract. */
import { buildIndex, fingerprint } from './index.mjs';
import { condense } from './condense.mjs';
import { describe, replayEntry, turnIdOf } from './records.mjs';
import { extractUuid } from '../../core/text.mjs';
import { loadIndex } from '../../core/index-cache.mjs';

const adapter = {
  id: 'codex',
  label: 'Codex',
  indexSchema: 1,
  buildIndex,
  fingerprint,
  /** codex://threads/<id> links belong to Codex unambiguously. */
  claim(raw) {
    if (!/^codex:\/\//i.test(String(raw ?? '').trim())) return null;
    const id = extractUuid(raw);
    return id ? (loadIndex(adapter).sessions.find((s) => s.id === id) ?? null) : null;
  },
  filesFor: (ref) => [...ref.files].sort(),
  condense,
  describe,
  replayEntry,
  turnIdOf,
};

export default adapter;
