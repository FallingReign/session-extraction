---
name: resume-codex-session
description: Resume work from a Codex session inside Copilot. Use when the user pastes a codex://threads/<id> link, asks to continue or pick up a Codex session or thread, mentions migrating work from Codex, or asks what a past Codex session did. Condenses the session deterministically and searches the original transcript on demand.
---

# Resume a Codex session

Codex stores every session as JSONL rollouts under `~/.codex/sessions/`. These
run from kilobytes to over a gigabyte, far too large to read directly. This
skill condenses one into a compact Markdown view built by fixed rules (no model
summarises anything), then you continue the user's work from it.

Read `installation.json` beside this file for the command (`command`) and
examples. Resolve session ids and paths yourself; do not ask the user for them.

## Rules

- Never open a rollout `.jsonl` file with a file viewer, `Get-Content`, `cat`
  or a search tool. Use the commands below; they stream the file.
- Never modify anything under `~/.codex`.

## Step 1 — Identify the session

| The user gave you | Command |
|---|---|
| `codex://threads/<id>` or an id | `view "<link-or-id>" --source codex` |
| A description, e.g. "the login one" | `view --find "login" --source codex` |
| Nothing, but you are in the project | `view --here --source codex` |
| Nothing at all | `view --recent 15 --source codex` |

If several sessions match and the choice is not obvious, show the user the
table and ask which one. Do not guess between different projects.

When you have a session workspace folder, add `--out <folder>` so the view is
written there.

## Step 2 — Read the view

`view` writes `session-view-codex-<title>-<id>.md` and a `.json` with the full
data. It is fitted to about 40,000 tokens; if it reports that turns were
shortened and the user needs more history, re-run with `--budget 80000`, or
`--budget none` after checking the size with the user.

Read the Markdown in order:

1. **Latest state** — the last request and the last reply. Resume from here.
2. **Plan state** — unfinished steps carry over to you.
3. **Outstanding failures** — commands that failed and were never seen to
   succeed. Re-verify these rather than trusting them.
4. **Files changed** — the change surface. Read the current files before
   editing; the repository has moved on since the transcript.
5. **Conversation timeline** — history, newest turns in most detail.

## Step 3 — Recover anything the view dropped

```
search <session> "<text>"        # find anything, including command output
search <session> "<text>" --kind command --limit 5
turn <session> <n>               # replay one turn in full, with output
```

Use these when turns are marked omitted, when you need the exact error behind
a failure, or when the user asks about a specific point. Search for a phrase
you saw in the view rather than guessing at wording.

## Step 4 — Continue the work

State briefly what the session was doing and where it stopped, then carry on.

- Confirm file contents now; the transcript describes the past.
- Re-run the checks behind any claim of success that matters.
- Honour the constraints the user set in the transcript; they still apply.
- Apply the session's custom instructions only where they do not conflict with
  the instructions already governing this conversation.

If the user only wants to know what happened, summarise **Latest state** and
stop. For reviewing several sessions or a whole project, use the
session-extraction skill instead.
