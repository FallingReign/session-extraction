/**
 * Copilot tool knowledge: which tools run shell commands, change files or
 * read files, and how to recover exit codes and changed paths from them.
 */
import path from 'node:path';
import { countLines } from '../../core/text.mjs';

export const SHELL_TOOLS = new Set(['powershell', 'bash', 'shell', 'local_shell']);
export const SHELL_FOLLOWUP_TOOLS = new Set([
  'read_powershell',
  'write_powershell',
  'stop_powershell',
  'list_powershell',
  'read_bash',
  'write_bash',
  'stop_bash',
  'list_bash',
]);
export const EDIT_TOOLS = new Set(['edit', 'str_replace', 'str-replace']);
export const SILENT_TOOLS = new Set(['report_intent', 'task_complete']);

const EXIT_RE = /<(?:shellId: [^<>]*? completed with|exited with) exit code (-?\d+)>\s*$/;
const BACKGROUND_RE = /started in (?:detached )?background with shellId/;

/**
 * Exit status of a shell call. Newer logs record shellExecution.exitCode; older
 * ones end the result text with "<exited with exit code N>" or "<shellId: X
 * completed with exit code N>". success:false means the command never ran.
 * Background starts have no exit code yet and count as successful launches.
 */
export function shellOutcome(complete) {
  const content = String(complete?.result?.content ?? '');
  if (complete?.success === false) {
    return { exit: 'blocked', background: false, errorText: complete?.error?.message ?? content };
  }
  const recorded = complete?.shellExecution?.exitCode;
  // The trailing exit-code marker repeats what the exit code already says.
  const output = content.replace(EXIT_RE, '').trimEnd();
  if (typeof recorded === 'number') return { exit: recorded, background: false, errorText: output };
  const m = EXIT_RE.exec(content);
  if (m) return { exit: Number(m[1]), background: false, errorText: output };
  return { exit: 0, background: BACKGROUND_RE.test(content), errorText: '' };
}

const resolveIn = (cwd, p) => (!p ? p : path.isAbsolute(p) || !cwd ? p : path.resolve(cwd, p));

/** Files an apply_patch call adds, updates, deletes or moves, with changed-line counts. */
export function patchFiles(args, cwd) {
  const text = typeof args === 'string' ? args : (args?.input ?? args?.patch ?? '');
  const files = [];
  let current = null;
  for (const line of String(text).split('\n')) {
    const head = /^\*\*\* (Add|Update|Delete) File: (.+?)\s*$/.exec(line);
    if (head) {
      current = { verb: head[1] === 'Add' ? 'add' : head[1] === 'Delete' ? 'delete' : 'update', path: resolveIn(cwd, head[2]), lines: 0 };
      files.push(current);
      continue;
    }
    const move = /^\*\*\* Move to: (.+?)\s*$/.exec(line);
    if (move && current) {
      // A move is the old path going away and the new path receiving the content.
      current.verb = 'delete';
      current = { verb: 'update', path: resolveIn(cwd, move[1]), lines: 0 };
      files.push(current);
      continue;
    }
    if (current && /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line)) current.lines++;
  }
  return files;
}

/** File changes made by a successful edit/create/apply_patch call. */
export function fileChangesOf(call, cwd) {
  const a = call.args ?? {};
  if (call.name === 'create') return [{ verb: 'add', path: resolveIn(cwd, a.path), lines: countLines(a.file_text) }];
  if (EDIT_TOOLS.has(call.name)) return [{ verb: 'update', path: resolveIn(cwd, a.path), lines: countLines(a.new_str) }];
  if (call.name === 'apply_patch') return patchFiles(call.args, cwd);
  return [];
}

/** Short human label for any other tool call. */
export function toolLabel(call) {
  const a = call.args && typeof call.args === 'object' ? call.args : {};
  const pick = a.description ?? a.query ?? a.url ?? a.pattern ?? a.path ?? a.title ?? a.skill ?? a.agent_id ?? a.shellId;
  return typeof pick === 'string' ? pick : pick != null ? String(pick) : '';
}
