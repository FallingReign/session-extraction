#!/usr/bin/env node
/**
 * Installs (or refreshes) the resume-codex-session skill for Copilot.
 * Copies the tool into the skill directory so the skill is self-contained,
 * and records the resolved Node executable for the agent to use.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const skillsRoot = process.env.COPILOT_SKILLS_DIR || path.join(os.homedir(), '.agents', 'skills');
const target = path.join(skillsRoot, 'resume-codex-session');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

fs.mkdirSync(target, { recursive: true });
fs.copyFileSync(path.join(repoRoot, 'skill', 'SKILL.md'), path.join(target, 'SKILL.md'));
fs.rmSync(path.join(target, 'src'), { recursive: true, force: true });
copyDir(path.join(repoRoot, 'src'), path.join(target, 'src'));

const cli = path.join(target, 'src', 'codex-migrate.mjs');
const q = (s) => `"${s}"`;
const base = `${q(process.execPath)} ${q(cli)}`;
const installation = {
  node: process.execPath,
  cli,
  command: base,
  examples: {
    byLink: `${base} resume "codex://threads/<id>"`,
    find: `${base} resume --find "<words>"`,
    here: `${base} resume --here`,
    recent: `${base} resume --recent 15`,
    search: `${base} search <session> "<text>"`,
    turn: `${base} turn <session> <n>`,
  },
  installedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(target, 'installation.json'), JSON.stringify(installation, null, 2), 'utf8');

console.log('\n  Installed resume-codex-session');
console.log(`  → ${target}`);
console.log(`  node: ${process.execPath}\n`);
