/** Text helpers shared by every source adapter and the renderer. */

export const clip = (s, n) => {
  if (!s) return '';
  const t = String(s).replace(/\s+$/, '');
  return t.length <= n ? t : t.slice(0, n) + ` …[+${t.length - n} chars]`;
};

/** Failures explain themselves at the end of their output, not the start. */
export const clipTail = (s, n) => {
  if (!s) return '';
  const t = String(s).replace(/\s+$/, '');
  return t.length <= n ? t : `…[${t.length - n} earlier chars omitted]\n` + t.slice(-n);
};

export const oneLine = (s, n = 200) => clip(String(s ?? '').replace(/\s+/g, ' ').trim(), n);

/** Normalised form used to tell whether two runs are "the same command". */
export const cmdKey = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();

export const countLines = (s) => (typeof s === 'string' && s ? s.split('\n').length : 0);

/** Lines added or removed in a unified diff, ignoring the +++/--- headers. */
export const diffLines = (diff) =>
  typeof diff === 'string' ? diff.split('\n').filter((l) => /^[+-][^+-]/.test(l)).length : 0;

export const human = (n) =>
  n > 1e9 ? `${(n / 1e9).toFixed(2)}GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`;

export const ago = (iso) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

export const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

export const extractUuid = (input) => {
  const m = String(input ?? '').match(UUID_RE);
  return m ? m[0].toLowerCase() : null;
};
