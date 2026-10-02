/** Markdown formatting helpers shared by the session and project renderers. */

const pad = (n) => String(n).padStart(2, '0');

export function fmtDuration(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${pad(s % 60)}s`;
  return `${Math.floor(m / 60)}h${pad(m % 60)}m`;
}

/** Local time, minute precision. */
export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const fmtDate = (iso) => (iso ? fmtTime(iso).slice(0, 10) : '—');

export const fmtSize = (n) =>
  n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;

export const dedupe = (arr) => [...new Set(arr)];

export function blockquote(text) {
  return String(text)
    .trim()
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}

export function clipDoc(s, n) {
  const t = String(s ?? '').trim();
  return t.length <= n ? t : t.slice(0, n) + `\n\n…[+${t.length - n} chars omitted]`;
}

/** Single line, ellipsis when cut. */
export const shortLine = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n) + '…';
};

/** Escape a value for a Markdown table cell. */
export const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

const SOURCE_LABELS = { codex: 'Codex', copilot: 'Copilot' };
export const sourceLabel = (id) => SOURCE_LABELS[id] ?? id ?? 'Agent';
