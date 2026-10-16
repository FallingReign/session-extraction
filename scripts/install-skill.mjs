#!/usr/bin/env node
/**
 * Installs (or refreshes) every skill under skills/.
 *
 * Each skill is installed self-contained: its SKILL.md, a copy of the tool's
 * source, and an installation.json with the resolved Node path and ready-to-run
 * commands. All skills run the same code. Re-run after pulling changes.
 *
 *   npx -y github:FallingReign/session-extraction [--dir <skills folder>]
 *   node scripts/install-skill.mjs [--dir <skills folder>]
 *
 * Default skills folder: ~/.agents/skills (override with --dir or SKILLS_DIR).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
// A clone records its folder; an npx run records the GitHub source, not its temporary cache.
const sourceRepo = fs.existsSync(path.join(repoRoot, '.git')) ? repoRoot : pkg.repository;
const dirFlag = process.argv.indexOf('--dir');
const skillsRoot =
  (dirFlag !== -1 && process.argv[dirFlag + 1]) || process.env.SKILLS_DIR || path.join(os.homedir(), '.agents', 'skills');

const skills = fs
  .readdirSync(path.join(repoRoot, 'skills'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(repoRoot, 'skills', d.name, 'SKILL.md')))
  .map((d) => d.name);

for (const name of skills) {
  const target = path.join(skillsRoot, name);
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'skills', name, 'SKILL.md'), path.join(target, 'SKILL.md'));
  // Replace the source wholesale so files removed from the repo do not linger.
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
      corpus: `${command} corpus --since 7d [--exclude <folder>] [--packets]`,
      find: `${command} find "<words>"`,
      here: `${command} here --folder <folder>`,
      search: `${command} search <session> "<text>"`,
      turn: `${command} turn <session> <n>`,
    },
    installedAt: new Date().toISOString(),
    sourceRepo,
  };
  fs.writeFileSync(path.join(target, 'installation.json'), JSON.stringify(installation, null, 2), 'utf8');
  console.log(`  Installed ${name} → ${target}`);
}
console.log(`  node ${process.execPath}\n`);
