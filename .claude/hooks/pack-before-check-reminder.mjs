#!/usr/bin/env node
// PreToolUse hook on Bash: hold the session's first typecheck (or workspace-wide
// test run) until a build has run. Why, and what counts as a build, is
// documented in the "New kitchen-sink subpaths need a built dist before
// `vp check`" section of docs/Testing/Testing Reference.md; REMINDER /
// TEST_REMINDER below are what the agent is told. Like push-test-reminder.mjs
// the hold fires once per session, so a retry proceeds.
//
// Fail-open by design: any unexpected input or error exits 0 with no output.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Subcommands that leave the workspace built.
const BUILD_SUBCOMMANDS = new Set(['build', 'pack'])
// Subcommands that type-check against the `default` (`dist/`) export condition.
// `vp lint` counts: `lint.options.typeCheck` is on in vite.config.ts, so lint
// runs the same tsgolint pass `vp check` does.
const CHECK_SUBCOMMANDS = new Set(['check', 'lint'])
// `vp run <script>` names that leave the workspace built.
const BUILD_SCRIPTS = new Set(['pack', 'build'])
// Per-package `check` is `vp check`; `lint` would be `vp lint`. Both need the
// build.
const CHECK_SCRIPTS = new Set(['check', 'lint'])
// Scripts that type-check *before* they build, so they need a pack of their
// own: root `ready` is `vp fmt && vp lint && … && vp run pack && …`, and its
// type-aware `vp lint` step fails on an unbuilt workspace long before the pack.
const CHECK_THEN_BUILD_SCRIPTS = new Set(['ready'])
// `vp run <script>` names that run the whole workspace's Vitest pass, which
// resolves cross-package imports against `dist/` and so needs a build first —
// same failure mode as a bare `vp test` (see classify()).
const TEST_SCRIPTS = new Set(['test:all'])

const REMINDER =
  'Held this typecheck (once per session): nothing has been built yet this session, and ' +
  'typecheck resolves tests against the `default` (`dist/`) export condition — so on a freshly ' +
  'bootstrapped container it reports cascades of errors that are only missing builds. See the ' +
  '"New kitchen-sink subpaths need a built dist before `vp check`" section of ' +
  'docs/Testing/Testing Reference.md. Run `vp run pack` first (`vp run -F <pkg> build` for one ' +
  'package). If the workspace is already built, or you mean to check against the current dist, ' +
  'retry the command — it will proceed.'

const TEST_REMINDER =
  'Held this test run (once per session): nothing has been built yet this session, and a ' +
  'workspace-wide `vp test` resolves cross-package imports against the `default` (`dist/`) export ' +
  'condition — so on a freshly bootstrapped container it fails hundreds of tests with `Cannot find ' +
  'module …/dist/…` that are only missing builds, not anything to do with your change. Run ' +
  '`vp run pack` once first; after that the full suite is green. A single package\'s suite run from ' +
  'its own directory (`vp test <filter>`) is fine without a build. If the workspace is already ' +
  'built, retry — it will proceed.'

// Drop heredoc bodies: their lines are data the shell feeds to a command, not
// commands. Without this a commit message or generated doc whose line *starts*
// with `vp check` trips the hold, and one starting with `vp run pack` silently
// satisfies it.
function withoutHeredocBodies(command) {
  const kept = []
  let terminator = null
  for (const line of command.split('\n')) {
    if (terminator !== null) {
      if (line.trim() === terminator) terminator = null
      continue
    }
    kept.push(line)
    const opener = /<<-?\s*(['"]?)([\w.-]+)\1/.exec(line)
    if (opener !== null) terminator = opener[2]
  }
  return kept.join('\n')
}

// Split a command into the segments a `&&` / `||` / `;` / `|` / newline chain
// runs in order, so `vp run pack && vp check` reads as a build followed by a
// check. Separators inside quotes don't split, so a `-m "…"` message body
// stays part of the `git` segment rather than becoming a command of its own.
function segmentsOf(command) {
  const segments = []
  let current = ''
  let quote = null
  for (const character of withoutHeredocBodies(command)) {
    if (quote !== null) {
      if (character === quote) quote = null
      current += character
    } else if (character === "'" || character === '"') {
      quote = character
      current += character
    } else if (character === '|' || character === ';' || character === '&' || character === '\n') {
      segments.push(current)
      current = ''
    } else {
      current += character
    }
  }
  segments.push(current)
  return segments
}

// A segment's `vp` argument list, or null. Only a `vp` in **command position**
// counts — otherwise prose that merely mentions `vp check` (a commit message
// heredoc, an `echo`, a `grep` pattern) would trip the hold. Leading
// `FOO=bar` assignments are skipped, and the workspace-local binary
// (`node_modules/.bin/vp check`) matches on its basename.
function vpArgs(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean)
  let index = 0
  while (index < tokens.length && /^\w+=/.test(tokens[index])) index += 1
  const command = tokens[index]
  if (command === undefined || command.split('/').pop() !== 'vp') return null
  return tokens.slice(index + 1)
}

// 'build' | 'check' | 'check-then-build' | 'test' | null for one `vp`
// invocation's arguments. 'test' is check-like (needs a build, leaves none) but
// carries its own reminder.
function classify(args) {
  const words = args.filter((arg) => !arg.startsWith('-'))
  const [subcommand, ...rest] = words
  if (subcommand === undefined) return null
  if (BUILD_SUBCOMMANDS.has(subcommand)) return 'build'
  if (CHECK_SUBCOMMANDS.has(subcommand)) return 'check'
  // A *bare* `vp test` runs the whole workspace and needs a build; a filtered
  // `vp test <filter>` (or a run from a single package's dir) narrows to one
  // suite and is fine unbuilt, so only hold when no positional filter follows.
  // Flags are already dropped, so `rest.length === 0` means no filter was given.
  if (subcommand === 'test') return rest.length === 0 ? 'test' : null
  if (subcommand !== 'run') return null
  // `vp run [-r] [-F <pkg>] <script>` — dropping the flags above leaves their
  // values behind, so match on membership rather than re-parsing vp's flag
  // grammar. No workspace package is named `pack`/`build`/`ready`/`check`/`lint`/`test:all`.
  if (rest.some((word) => CHECK_THEN_BUILD_SCRIPTS.has(word))) return 'check-then-build'
  if (rest.some((word) => BUILD_SCRIPTS.has(word))) return 'build'
  if (rest.some((word) => CHECK_SCRIPTS.has(word))) return 'check'
  if (rest.some((word) => TEST_SCRIPTS.has(word))) return 'test'
  return null
}

// Walk the command left to right, carrying whether a build has been seen. A
// `check-then-build` needs the build to already exist *and* leaves one behind.
// `holdKind` is the first held invocation's kind, so the reminder matches what
// was actually blocked ('test' → TEST_REMINDER, otherwise REMINDER).
function scanCommand(command, alreadyBuilt) {
  let built = alreadyBuilt
  let holdKind = null
  for (const segment of segmentsOf(command)) {
    const args = vpArgs(segment)
    if (args === null) continue
    const kind = classify(args)
    if ((kind === 'check' || kind === 'check-then-build' || kind === 'test') && !built && holdKind === null) {
      holdKind = kind
    }
    if (kind === 'build' || kind === 'check-then-build') built = true
  }
  return { built, holdKind }
}

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  if (input.tool_name !== 'Bash') return
  const command = input.tool_input?.command
  if (typeof command !== 'string') return

  const stateDir = join(tmpdir(), 'claude-pack-reminder')
  // State has to land before the hold is emitted — a failed write would
  // otherwise leave a deny the retry can't clear. Flattening the session id
  // keeps a stray separator from turning the write into a missing-dir throw.
  const sessionKey = String(input.session_id ?? 'unknown').replace(/[^\w.-]/g, '_')
  const stateFile = join(stateDir, `${sessionKey}.json`)
  let state = { built: false, reminded: false }
  try {
    const stored = JSON.parse(readFileSync(stateFile, 'utf8'))
    state = { built: stored.built === true, reminded: stored.reminded === true }
  } catch {
    // First Bash call of the session: no state file yet.
  }

  const { built, holdKind } = scanCommand(command, state.built)
  const hold = holdKind !== null && !state.reminded
  // A held command never runs, so a build later in the same line hasn't
  // happened either — only record one when the command is let through.
  const nextBuilt = hold ? state.built : built
  if (nextBuilt !== state.built || hold) {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(stateFile, JSON.stringify({ built: nextBuilt, reminded: state.reminded || hold }))
  }
  if (!hold) return

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: holdKind === 'test' ? TEST_REMINDER : REMINDER,
      },
    })
  )
}

try {
  main()
} catch {
  // Fail open.
}
