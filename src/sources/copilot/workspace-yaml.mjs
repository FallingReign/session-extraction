/**
 * Minimal reader for Copilot's workspace.yaml: flat `key: value` pairs, with
 * plain, single-quoted, double-quoted and block (| |- > >-) scalar values.
 * That is the full shape observed across every session on record; nested
 * mappings are not used by the file.
 */
export function parseWorkspaceYaml(text) {
  const out = {};
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    const raw = (m[2] ?? '').trim();

    if (/^[|>][-+]?$/.test(raw)) {
      const block = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) {
        block.push(lines[++i].replace(/^ {2}/, ''));
      }
      while (block.length && block[block.length - 1] === '') block.pop();
      out[key] = raw.startsWith('>') ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n');
      continue;
    }
    out[key] = scalar(raw);
  }
  return out;
}

function scalar(raw) {
  if (raw === '' || raw === '~' || raw === 'null') return null;
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  return raw;
}
