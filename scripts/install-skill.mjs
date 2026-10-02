#!/usr/bin/env node
/**
 * Installs (or refreshes) the session-extraction skill.
 *
 * Copies SKILL.md and the tool's source into the skills folder so the skill is
 * self-contained, and writes installation.json with the resolved Node path and
 * ready-to-run commands. Re-run after pulling changes.
 *
 *   node scripts/install-skill.mjs [--dir <skills folder>]
 *
 * Default skills folder: ~/.agents/skills (override with --dir or SKILLS_DIR).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const NAME = 'session-extraction';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirFlag = process.argv.indexOf('--dir');
const skillsRoot =
  (dirFlag !== -1 && process.argv[dirFlag + 1]) || process.env.SKILLS_DIR || path.join(os.homedir(), '.agents', 'skills');
const target = path.join(skillsRoot, NAME);

fs.mkdirSync(target, { recursive: true });
fs.copyFileSync(path.join(repoRoot, 'skill', 'SKILL.md'), path.join(target, 'SKILL.md'));
fs.rmSync(path.join(target, 'src'), { recursive: true, force: true });
fs.cpSync(path.join(repoRoot, 'src'), path.join(target, 'src'), { recursive: true });
fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(target, 'package.json'));

const cli = path.join(target, 'src', 'cli.mjs');
const command = `"${process.execPath}" "${cli}"`;
const installation = {
  node: process.execPath,
  cli,
  command,
  examples: {
    view: `${command} view <session>`,
    project: `${command} project <folder>`,
    find: `${command} find "<words>"`,
    here: `${command} here --folder <folder>`,
    search: `${command} search <session> "<text>"`,
    turn: `${command} turn <session> <n>`,
  },
  installedAt: new Date().toISOString(),
  sourceRepo: repoRoot,
};
fs.writeFileSync(path.join(target, 'installation.json'), JSON.stringify(installation, null, 2), 'utf8');

console.log(`\n  Installed ${NAME}\n  → ${target}\n  node ${process.execPath}\n`);
