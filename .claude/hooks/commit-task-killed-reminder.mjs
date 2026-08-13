#!/usr/bin/env node
// PostToolUse hook on Bash: when a `git commit` fails and its output contains
// "Task killed", inject context explaining that the named task is the VICTIM,
// not the culprit — `vp staged` (the pre-commit hook) runs its per-glob tasks
// concurrently and kills the survivors when one fails, so the kill line points
// at whatever it happened to kill (usually `vp check --fix`) rather than the
// real failure (usually `cargo fmt --check`, further up the output). The Git
// hooks section of CONTRIBUTING.md and AGENTS.md carry the same guidance.
//
// This fires whenever the condition holds (a failed commit is inherently rare
// and each occurrence is a fresh diagnostic moment), so there is no per-session
// latch — unlike the PreToolUse holds, which nag once and then defer.
//
// Fail-open by design: any unexpected input or error exits 0 with no output —
// a diagnostic nudge is never worth breaking a tool call over.

import { readFileSync } from 'node:fs'

const REMINDER =
  '`git commit` failed with "Task killed" — that names the VICTIM task, not the culprit. `vp staged` ' +
  '(the pre-commit hook) runs its per-glob tasks concurrently and kills the survivors the moment one ' +
  'fails, so `✖ Task killed: vp check --fix` is a task that got killed, not the one that broke. When ' +
  'Rust files are staged the real failure is usually `rust.sh pre-commit`\'s `cargo fmt --check` ' +
  'printing "Diff in …" blocks further UP in the output (hand-written Rust that is not rustfmt-clean); ' +
  'a standalone `node_modules/.bin/vp check --fix` passing while the commit keeps failing is the tell. ' +
  'Fix: run `cargo fmt`, restage, and commit again — and scroll up past the kill line for the actual ' +
  'diffs. Two side gotchas: (1) a standalone `vp check --fix` can reformat files AFTER you staged ' +
  'them, so restage before retrying; (2) do not run a background `cargo check` while committing — it ' +
  'contends with the hook\'s rust.sh on the cargo target lock.'

// The Bash tool output. Its shape varies across Claude Code versions — a
// `{ type, text }` object in current docs, a `{ stdout, stderr }` object in
// others, or a bare string — so read whichever is present rather than pin one.
function outputText(response) {
  if (typeof response === 'string') return response
  if (response !== null && typeof response === 'object') {
    if (typeof response.text === 'string') return response.text
    const parts = []
    if (typeof response.stdout === 'string') parts.push(response.stdout)
    if (typeof response.stderr === 'string') parts.push(response.stderr)
    if (parts.length > 0) return parts.join('\n')
  }
  return ''
}

// True when a pipeline segment runs `git commit` in command position. Splitting
// on the separators a shell chains on keeps a `git commit` buried in an earlier
// segment's argument (a prose `-m "…"` body stays one token under whitespace
// split, so its words never read as a command) from matching, and the leading
// `FOO=bar` env-assignment skip mirrors pack-before-check-reminder.mjs.
function isGitCommit(command) {
  return command.split(/[|;&\n]+/).some((segment) => {
    const tokens = segment.trim().split(/\s+/).filter(Boolean)
    let index = 0
    while (index < tokens.length && /^\w+=/.test(tokens[index])) index += 1
    const binary = tokens[index]
    if (binary === undefined || binary.split('/').pop() !== 'git') return false
    const args = tokens.slice(index + 1).filter((token) => !token.startsWith('-'))
    return args[0] === 'commit'
  })
}

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  if (input.tool_name !== 'Bash') return
  const command = input.tool_input?.command
  if (typeof command !== 'string' || !isGitCommit(command)) return
  // Match the kill summary's exact `Task killed: <task>` form (colon included),
  // not the bare phrase — a successful commit echoes its subject line back, so a
  // commit whose message merely mentions "Task killed" must not trip this.
  if (!outputText(input.tool_response).includes('Task killed:')) return

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: REMINDER,
      },
    })
  )
}

try {
  main()
} catch {
  // Fail open.
}
