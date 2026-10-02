# session-extraction

Context-dense, deterministic views of **Codex** and **GitHub Copilot CLI**
agent sessions, for reviewing what happened and gathering data for analysis.

Both tools record every session as a JSONL event log on disk. A single session
can exceed a gigabyte, far too much for an agent to read, and a model-written
summary of one is unreliable. This tool takes a third path: **fixed reduction
rules plus on-demand retrieval**.

- Requests and replies are quoted verbatim.
- Every command, file change, file read and tool call becomes one line;
  repeats collapse to a count.
- Command output, file bodies and encrypted reasoning are dropped, except the
  tail of commands that failed.
- Large sessions are fitted to a token budget: the newest turns stay in full
  and older turns shorten. Anything dropped can be recovered with `search` or
  `turn`, which stream the original log.
- Nothing is summarised by a model. Text the original tool wrote about itself
  (checkpoint summaries) is labelled as such.

Requires Node.js 20 or later, and 22.13 or later to read Copilot plan state
from each session's SQLite todo table. No dependencies.

## Usage

```sh
node src/cli.mjs list                               # recent sessions, both tools
node src/cli.mjs find "login page"                  # search titles and folders
node src/cli.mjs here --folder ~/code/my-app        # sessions started in a folder

node src/cli.mjs view codex://threads/<id>          # one Codex session
node src/cli.mjs view ~/.copilot/session-state/<id> # one Copilot session
node src/cli.mjs view 1a2b3c4d                      # any session, by id prefix

node src/cli.mjs project ~/code/my-app              # every session for a project
node src/cli.mjs project . --since 2026-09-01 --last 20

node src/cli.mjs search 1a2b3c4d "TypeError"        # find anything, incl. output
node src/cli.mjs turn 1a2b3c4d 12                   # replay one turn in full
```

`view` and `project` write a Markdown view and a JSON file with the full
structured data (default folder `~/.copilot/session-extraction/packets`, or
`--out <dir>`, or `--stdout`). `--budget <tokens>` sets the size (default
40000); `--budget none` renders everything. `--source codex|copilot` limits to
one tool.

### Session view

Header (ids, link, resume command, folder, repository, model, span, size),
**Latest state** (last request and reply), plan state from the session's own
todo list, **outstanding failures** (failed commands never seen to succeed
later), files changed and most-read files, a turn-by-turn timeline, and a
reference section (deduplicated commands, tools, sub-agent reports, the latest
checkpoint summary, custom instructions).

### Project view

Every session whose working folder is the project or a subfolder, from both
tools, coded S1, S2, … in start order: overview, session table, latest state,
unfinished plan items, files changed in more than one session, failures that
recur across sessions, a card per session, and every user request in order.

## Agent skill

```sh
node scripts/install-skill.mjs            # installs to ~/.agents/skills/session-extraction
```

The skill (`skill/SKILL.md`) tells an agent when to use each command, how to
read the output, and to query the JSON for analysis. It is self-contained; re-run
the installer after updating the repository.

## Where sessions are read from

| Tool | Location | Notes |
|---|---|---|
| Codex | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` (default `~/.codex`) | One thread can span several files; they are grouped by the session id in each file's first record. |
| Copilot CLI | `$COPILOT_HOME/session-state/<id>/events.jsonl` (default `~/.copilot`) | Metadata from `workspace.yaml`, plan from `plan.md` and the session's todo table. |

Neither event format is publicly specified. The reduction rules were derived
from surveying every record type in real logs; the `probe/` scripts that did
the surveying are kept so the rules can be re-derived when a format changes.

The session index is cached under `~/.copilot/session-extraction/` and kept
current incrementally: only new or changed log files are re-read.

## Verification

```sh
node scripts/verify.mjs [--source codex|copilot] [--sample=40] [--max-bytes=30000000]
```

For a spread of sessions, recounts commands, failures and changed files
directly from the raw logs, using code independent of the adapters, and checks
the views agree exactly, that every session id is present, and that no request
is repeated within a turn.

## Layout

```
src/cli.mjs                     command line
src/core/sources.mjs            adapter registry and session resolution
src/core/index-cache.mjs        incremental session index
src/core/packet-builder.mjs     source-neutral session packet
src/core/budget.mjs             fitting output to a token budget
src/core/render-markdown.mjs    session view
src/core/project.mjs            cross-session aggregation
src/core/render-project.mjs     project view
src/core/retrieve.mjs           search and turn replay over raw logs
src/core/format.mjs, text.mjs, jsonl.mjs
src/sources/codex/              Codex adapter
src/sources/copilot/            Copilot CLI adapter
scripts/verify.mjs              fidelity harness
scripts/install-skill.mjs       skill installer
skill/SKILL.md                  agent skill
probe/                          format survey scripts
```

### Adding a source

Implement the adapter contract documented in `src/core/sources.mjs`
(`listFiles`, `readHeader`, `buildRefs`, `claim`, `filesFor`, `condense`,
`reader`), translating the tool's records into `PacketBuilder` calls, and
register it in `ADAPTERS`. Add a ground-truth counter for it in
`scripts/verify.mjs`.

## Privacy

Session logs contain whatever was typed, read and run, including private or
work data. Views are written locally and are excluded from git by
`.gitignore`. Do not commit them or paste them into public places.

## License

MIT
