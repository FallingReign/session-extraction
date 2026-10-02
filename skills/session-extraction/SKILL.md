---
name: session-extraction
description: Review or analyse past Codex and Copilot CLI agent sessions without reading raw transcripts. Use when asked to look at, review, summarise, compare or gather data from agent sessions, session history or session files; when given a codex://threads/<id> link, a Copilot session folder path or session id to inspect; or when asked what happened across sessions in a project folder. Produces deterministic, context-dense views and searches the original transcripts on demand. To continue a Codex session's work instead of reviewing it, use resume-codex-session.
---

# Session extraction

Codex and Copilot CLI record every session as a JSONL event log. Logs run from
kilobytes to over a gigabyte, so they are never read directly. This skill turns
them into compact Markdown views built by fixed rules: requests and replies are
quoted verbatim, everything else is reduced deterministically, and no model
summarises anything. Each view has a JSON file beside it holding the full
structured data.

Read `installation.json` beside this file for the command (`command`) and
examples. Resolve session ids and paths yourself; do not ask the user for them.

## Rules

- Never open a session's `.jsonl` file with a file viewer, `Get-Content`, `cat`
  or a search tool. Use the commands below; they stream the file.
- The commands only read. Never modify anything under `~/.codex/sessions` or
  `~/.copilot/session-state`.
- Session text can contain private or work data. Do not paste it into external
  services, issues or public repositories.
- When you have a session workspace folder, write output there with
  `--out <folder>`. Otherwise the default output folder is fine.

## Pick the view

| The user wants | Command |
|---|---|
| One session reviewed | `view <session>` |
| Everything that happened in a project | `project <folder>` |
| Several projects | `project` once per folder, then compare the outputs |
| To find a session | `find "<words>"`, `here --folder <dir>`, `list` |
| A detail the view left out | `search <session> "<text>"`, `turn <session> <n>` |

`<session>` is any of: a `codex://threads/<id>` link, a Copilot session folder
path (`…\.copilot\session-state\<id>`), a full session id, or its first 8+
characters. Add `--source codex` or `--source copilot` to limit to one tool.

If a search returns several plausible sessions for different projects, show
the user the table and ask which one.

## Reading a session view (`view`)

Writes `session-view-<tool>-<title>-<id>.md` and `.json`. Read the Markdown in
order:

1. **Latest state** — the last request and the agent's last reply.
2. **Plan state** — the session's own todo list, unfinished items marked.
3. **Outstanding failures** — commands that failed and never later succeeded,
   with the end of their error output.
4. **Files changed** and **Most-read files** — the change surface.
5. **Conversation timeline** — each turn: the request (including the agent's
   questions and the user's answers, verbatim), the agent's reasoning headlines
   and progress notes, then one line per action (`$` command, `±` file change,
   `›` file read, `→` sub-agent, `⚙` other tool, `✗` failed).
6. **Reference** — deduplicated commands, tools, sub-agent reports, the latest
   checkpoint summary, and the custom instructions in force.

Large sessions are fitted to about 40,000 tokens: the newest turns stay in
full, older turns are shortened or omitted, and the view says so. Nothing is
lost. Use `turn <session> <n>` to replay an omitted turn with full command
output, or `search` to find any text, including output the view dropped.
Use `--budget 80000` for more, or `--budget none` for everything; check the
size with the user before going above 100,000.

Sections labelled as written by Copilot or Codex (checkpoint summaries) are
model-written by the original tool. Treat them as claims, not records.

## Reading a project view (`project`)

Covers every session whose working folder is the project folder or one of its
subfolders (`--exact` for the folder only). Narrow with `--since YYYY-MM-DD`,
`--until YYYY-MM-DD` or `--last N`.

Sessions get codes **S1, S2, …** in start order; use these codes when you
report. The report holds: an overview, the session table, the latest state,
unfinished plan items, files changed in more than one session, outstanding
failures that recur across sessions, a card per session, and every user
request in order, one line each.

## Analysis

For counts, trends and comparisons, query the JSON file rather than reading
numbers out of the Markdown. It holds everything, including requests and files
the Markdown left out.

- Session JSON: `session`, `plan`, `turns[]` (`ask`, `final`, `notes`,
  `reasoning`, `actions`), `ledger` (`files`, `reads`, `commands`, `errors`,
  `outstanding`, `mcp`, `searches`, `delegations`), `stats`.
- Project JSON: `totals`, `sessions[]` (one card each, including every request
  in `asks[]`), `files[]`, `failures[]`, `tools[]`.

Report findings against what the user asked for, cite session codes or turn
numbers, and say when a finding rests on model-written text.
