#!/usr/bin/env node
// PostToolUse hook: when Claude reads or edits a file in an area covered by
// project docs, inject a one-time "relevant docs" pointer into context so the
// docs get read instead of the code being re-derived. Mapping lives in
// doc-map.json next to this script; see
// docs/Agents/Doc Reminders Explanation.md for the design.
//
// Fail-open by design: any unexpected input or error exits 0 with no output —
// a doc reminder is never worth breaking a tool call over.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const EDIT_TOOLS = new Set(['Edit', 'Write'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob'])

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  const toolName = input.tool_name
  const isEdit = EDIT_TOOLS.has(toolName)
  if (!isEdit && !READ_TOOLS.has(toolName)) return

  const rawPath = input.tool_input?.file_path ?? input.tool_input?.path
  if (typeof rawPath !== 'string' || rawPath.length === 0) return

  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? input.cwd
  if (typeof projectDir !== 'string' || projectDir.length === 0) return
  const absPath = isAbsolute(rawPath) ? rawPath : join(input.cwd ?? projectDir, rawPath)
  const relPath = relative(projectDir, absPath)
  if (relPath.startsWith('..')) return
  const repoPath = relPath.split(sep).join('/')

  const hookDir = dirname(fileURLToPath(import.meta.url))
  const map = JSON.parse(readFileSync(join(hookDir, 'doc-map.json'), 'utf8'))

  const stateDir = join(tmpdir(), 'claude-doc-reminders')
  const stateFile = join(stateDir, `${input.session_id ?? 'unknown'}.json`)
  let seen = []
  try {
    seen = JSON.parse(readFileSync(stateFile, 'utf8'))
  } catch {
    // First reminder of the session: no state file yet.
  }
  const seenSet = new Set(Array.isArray(seen) ? seen : [])

  const lines = []
  for (const rule of map.rules) {
    if (seenSet.has(rule.id)) continue
    if (rule.tools === 'edit' && !isEdit) continue
    if (!new RegExp(rule.pattern).test(repoPath)) continue
    seenSet.add(rule.id)
    for (const doc of rule.docs) lines.push(`- ${doc}`)
  }
  if (lines.length === 0) return

  mkdirSync(stateDir, { recursive: true })
  writeFileSync(stateFile, JSON.stringify([...seenSet]))

  const verb = isEdit ? 'editing' : 'reading'
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          `Docs relevant to ${repoPath} (you are ${verb} in a documented area — ` +
          `read these before going further if you haven't):\n${lines.join('\n')}`,
      },
    })
  )
}

try {
  main()
} catch {
  // Fail open.
}
