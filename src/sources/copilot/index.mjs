/**
 * Copilot CLI session discovery.
 *
 * Each session is a folder under ~/.copilot/session-state/<id>/ (or under
 * COPILOT_HOME). The documented contents are an event log (events.jsonl) plus
 * workspace artifacts such as plans, checkpoints and tracked files. Folders
 * without an events.jsonl hold no transcript and are skipped.
 *
 * Metadata comes from workspace.yaml (id, cwd, name, timestamps, client, git)
 * and the session.start event on the log's first line (version, model).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readFirstLine } from '../../core/jsonl.mjs';
import { parseWorkspaceYaml } from './workspace-yaml.mjs';

export const COPILOT_HOME = process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
export const SESSIONS_ROOT = path.join(COPILOT_HOME, 'session-state');

const statOrNull = (p) => {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
};

/** Every session event log, with an mtime that also reflects title/metadata edits. */
export function listFiles() {
  let dirs;
  try {
    dirs = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const dir = path.join(SESSIONS_ROOT, d.name);
    const ev = statOrNull(path.join(dir, 'events.jsonl'));
    if (!ev) continue;
    const ws = statOrNull(path.join(dir, 'workspace.yaml'));
    out.push({
      file: path.join(dir, 'events.jsonl'),
      mtimeMs: Math.max(ev.mtimeMs, ws?.mtimeMs ?? 0),
      size: ev.size,
    });
  }
  return out;
}

/** Copilot stores the opening prompt as the name of unnamed sessions; keep one line. */
function titleFrom(name) {
  if (!name) return null;
  const line = String(name)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !/^[#[<]/.test(l));
  if (!line) return null;
  return line.length > 100 ? line.slice(0, 100).replace(/\s+\S*$/, '') + '…' : line;
}

export function readHeader(file, stat) {
  const dir = path.dirname(file);
  let ws = {};
  try {
    ws = parseWorkspaceYaml(fs.readFileSync(path.join(dir, 'workspace.yaml'), 'utf8'));
  } catch {
    /* metadata file missing; fall back to the event log */
  }
  let start = null;
  try {
    const rec = JSON.parse(readFirstLine(file));
    if (rec?.type === 'session.start') start = rec.data;
  } catch {
    /* unusual first line */
  }
  const id = String(ws.id ?? start?.sessionId ?? path.basename(dir)).toLowerCase();
  return {
    id,
    dir,
    file,
    bytes: stat.size,
    mtimeMs: stat.mtimeMs,
    startedAt: ws.created_at ?? start?.startTime ?? null,
    cwd: ws.cwd ?? start?.context?.cwd ?? null,
    title: titleFrom(ws.name ?? ws.summary),
    userNamed: ws.user_named === true,
    originator: ws.client_name ?? start?.producer ?? null,
    model: start?.selectedModel ?? null,
    clientVersion: start?.copilotVersion ?? null,
    gitRoot: ws.git_root ?? null,
    branch: ws.branch ?? null,
    repository: ws.repository ?? null,
  };
}

export function buildRefs(headers) {
  return headers.map((h) => ({
    source: 'copilot',
    id: h.id,
    title: h.title,
    cwd: h.cwd,
    model: h.model,
    originator: h.originator,
    clientVersion: h.clientVersion,
    startedAt: h.startedAt,
    updatedAt: new Date(h.mtimeMs).toISOString(),
    mtimeMs: h.mtimeMs,
    bytes: h.bytes,
    segmentCount: 1,
    files: [h.file],
    dir: h.dir,
    link: h.dir,
    resume: `copilot --resume ${h.id}`,
    gitRoot: h.gitRoot,
    branch: h.branch,
    repository: h.repository,
  }));
}

/** The session id for a path inside the session-state folder, if it is one. */
export function sessionIdFromPath(raw) {
  const s = String(raw ?? '').trim().replace(/^["']|["']$/g, '');
  if (!s || !/[\\/]/.test(s)) return null;
  const rel = path.relative(SESSIONS_ROOT, path.resolve(s));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(/[\\/]/)[0].toLowerCase();
}
