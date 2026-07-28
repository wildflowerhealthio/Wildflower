#!/usr/bin/env node
// PreToolUse hook on Bash: hold the session's first `vp check` until a build has
// run. Why, and what counts as a build, is documented in the "New kitchen-sink
// subpaths need a built dist before `vp check`" section of
// docs/Testing/Testing Reference.md; REMINDER below is what the agent is told.
// Like push-test-reminder.mjs the hold fires once per session, so a retry
// proceeds.
//
// Fail-open by design: any unexpected input or error exits 0 with no output.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// `vp run <script>` names that leave the workspace built. `ready` qualifies
// because it runs `vp run pack` before `vp run test:all`.
const BUILD_SCRIPTS = new Set(['pack', 'build', 'ready'])
// The per-package `check` script is `vp check`, so it needs the same build.
const CHECK_SCRIPT = 'check'

const REMINDER =
  'Held this `vp check` (once per session): nothing has been built yet this session, and ' +
  'typecheck resolves tests against the `default` (`dist/`) export condition — so on a freshly ' +
  'bootstrapped container it reports cascades of errors that are only missing builds. See the ' +
  '"New kitchen-sink subpaths need a built dist before `vp check`" section of ' +
  'docs/Testing/Testing Reference.md. Run `vp run pack` first (`vp run -F <pkg> build` for one ' +
  'package; `vp run ready` packs too). If the workspace is already built, or you mean to check ' +
  'against the current dist, retry the command — it will proceed.'

// Split a command into the segments a `&&` / `||` / `;` / `|` / newline chain
// runs in order, so `vp run pack && vp check` reads as a build followed by a
// check. Newlines matter because a heredoc body arrives as part of the command.
function segmentsOf(command) {
  return command.split(/[|;&\n]+/)
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

// 'build' | 'check' | null for one `vp` invocation's arguments.
function classify(args) {
  const words = args.filter((arg) => !arg.startsWith('-'))
  const [subcommand, ...rest] = words
  if (subcommand === 'build') return 'build'
  if (subcommand === 'check') return 'check'
  if (subcommand !== 'run') return null
  // `vp run [-r] [-F <pkg>] <script>` — dropping the flags above leaves their
  // values behind, so match on membership rather than re-parsing vp's flag
  // grammar. No workspace package is named `pack`/`build`/`ready`/`check`.
  if (rest.some((word) => BUILD_SCRIPTS.has(word))) return 'build'
  if (rest.includes(CHECK_SCRIPT)) return 'check'
  return null
}

// Walk the command left to right, carrying whether a build has been seen.
function scanCommand(command, alreadyBuilt) {
  let built = alreadyBuilt
  for (const segment of segmentsOf(command)) {
    const args = vpArgs(segment)
    if (args === null) continue
    const kind = classify(args)
    if (kind === 'build') built = true
    else if (kind === 'check' && !built) return { built, holdsCheck: true }
  }
  return { built, holdsCheck: false }
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

  const { built, holdsCheck } = scanCommand(command, state.built)
  const hold = holdsCheck && !state.reminded
  if (built !== state.built || hold) {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(stateFile, JSON.stringify({ built, reminded: state.reminded || hold }))
  }
  if (!hold) return

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: REMINDER,
      },
    })
  )
}

try {
  main()
} catch {
  // Fail open.
}
