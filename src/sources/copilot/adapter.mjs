/** Copilot CLI source adapter. See core/sources.mjs for the adapter contract. */
import { listFiles, readHeader, buildRefs, sessionIdFromPath } from './index.mjs';
import { condense } from './condense.mjs';
import { reader } from './records.mjs';
import { loadIndex } from '../../core/index-cache.mjs';

const adapter = {
  id: 'copilot',
  label: 'Copilot',
  indexSchema: 1,
  listFiles,
  readHeader,
  buildRefs,
  /** A path inside the session-state folder (the session folder or any file in it). */
  claim(raw) {
    const id = sessionIdFromPath(raw);
    return id ? (loadIndex(adapter).sessions.find((s) => s.id === id) ?? null) : null;
  },
  filesFor: (ref) => ref.files,
  condense,
  /** Turn membership needs state, so every line must be read. */
  turnIdInLine: false,
  reader,
};

export default adapter;
