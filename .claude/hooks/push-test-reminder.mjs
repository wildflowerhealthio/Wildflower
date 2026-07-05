#!/usr/bin/env node
// PreToolUse hook on Bash: the repo deliberately does NOT run tests from a git
// pre-push hook (see the Git hooks section of AGENTS.md). Instead, the first
// `git push` of a session is held with a reminder to confirm the relevant
// checks were run; retrying the push goes through. State is per-session, so
// the inquiry happens once, not on every push.
//
// Fail-open by design: any unexpected input or error exits 0 with no output.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REMINDER =
  'Held this push (once per session): tests are not run by a git pre-push hook. ' +
  'Confirm the outgoing changes have had their relevant checks run and passing this session: ' +
  '`vp run test:changed` for TS (use node_modules/.bin/vp in web sessions), and ' +
  '`./scripts/checks/rust.sh pre-push` when Rust files changed. ' +
  'If the checks have been run (or the user explicitly said to push without them), retry the push — it will proceed. ' +
  'Otherwise run the checks first; if they fail, surface the failures instead of pushing.'

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  if (input.tool_name !== 'Bash') return
  const command = input.tool_input?.command
  if (typeof command !== 'string') return
  // Token-match each pipeline segment: `push` must be its own git argument,
  // so paths like `.vite-hooks/pre-push` and `git stash push` don't trip it.
  const isRemotePush = command.split(/[|;&]+/).some((segment) => {
    const tokens = segment.trim().split(/\s+/)
    const gitIndex = tokens.indexOf('git')
    if (gitIndex === -1) return false
    const args = tokens.slice(gitIndex + 1)
    return args.includes('push') && !args.includes('stash')
  })
  if (!isRemotePush) return

  const stateDir = join(tmpdir(), 'claude-push-reminder')
  const stateFile = join(stateDir, `${input.session_id ?? 'unknown'}.json`)
  try {
    readFileSync(stateFile)
    return // Already reminded this session — defer to the normal permission flow.
  } catch {
    // First push of the session: record it, then hold the push below.
  }
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(stateFile, '{"reminded":true}')

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
