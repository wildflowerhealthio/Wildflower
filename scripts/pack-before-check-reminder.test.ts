import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

// The hook under test lives in `.claude/hooks/`, which is excluded from
// lint/fmt and belongs to no workspace package — so its tests live here with
// the other repo-tooling tests rather than next to it.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const hookPath = join(repoRoot, '.claude', 'hooks', 'pack-before-check-reminder.mjs')

// The hook keys its session state off `os.tmpdir()`. Pointing the child
// process's temp dir at a fresh directory isolates every run from the real
// session state (and from previous runs of this suite).
let stateHome: string
beforeAll(() => {
  stateHome = mkdtempSync(join(tmpdir(), 'wf-pack-reminder-'))
})
afterAll(() => {
  rmSync(stateHome, { recursive: true, force: true })
})

const runHook = (
  sessionId: string,
  command: string,
  toolName = 'Bash',
  toolInput: unknown = { command }
): string =>
  execFileSync(process.execPath, [hookPath], {
    input: JSON.stringify({ session_id: sessionId, tool_name: toolName, tool_input: toolInput }),
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: stateHome, TEMP: stateHome, TMP: stateHome },
  })

// Decoding doubles as the assertion: anything but a well-formed PreToolUse deny
// throws here, so the tests below only have to say held / not held.
const HoldOutput = Schema.parseJson(
  Schema.Struct({
    hookSpecificOutput: Schema.Struct({
      hookEventName: Schema.Literal('PreToolUse'),
      permissionDecision: Schema.Literal('deny'),
      permissionDecisionReason: Schema.String,
    }),
  })
)

/** The deny reason the hook emitted, or `undefined` when it let the call through. */
const heldReason = (output: string): string | undefined =>
  output.trim() === ''
    ? undefined
    : Schema.decodeUnknownSync(HoldOutput)(output).hookSpecificOutput.permissionDecisionReason

describe('pack-before-check-reminder hook', () => {
  it('holds the first unbuilt `vp check` and points at `vp run pack`', () => {
    const reason = heldReason(runHook('holds-first-check', 'vp check'))
    expect(reason).toContain('vp run pack')
    expect(reason).toContain('docs/Testing/Testing Reference.md')
  })

  it('lets the retry through — the hold is once per session', () => {
    expect(heldReason(runHook('retry-proceeds', 'vp check'))).toBeDefined()
    expect(heldReason(runHook('retry-proceeds', 'vp check'))).toBeUndefined()
    // ...and stays through for every later check, not just the second.
    expect(heldReason(runHook('retry-proceeds', 'vp check --fix'))).toBeUndefined()
  })

  it.each([
    ['vp run pack'],
    ['vp build'],
    // The bare subcommand, as used by global/kitchen-sink/README.md and the
    // `vp pack` references in vite.config.ts / docs/Agents/Strategies.md.
    ['vp pack'],
    ['vp run -r build'],
    ['vp run -F kitchen-sink build'],
  ])('treats `%s` as a build, so a later check is not held', (buildCommand) => {
    const session = `build-${buildCommand}`
    expect(heldReason(runHook(session, buildCommand))).toBeUndefined()
    expect(heldReason(runHook(session, 'vp check'))).toBeUndefined()
  })

  it('holds `vp lint` — `lint.options.typeCheck` makes it type-check too', () => {
    expect(heldReason(runHook('lint-held', 'vp lint'))).toBeDefined()
  })

  it('lets `vp lint` through once something has been built', () => {
    expect(heldReason(runHook('lint-after-pack', 'vp run pack'))).toBeUndefined()
    expect(heldReason(runHook('lint-after-pack', 'vp lint'))).toBeUndefined()
  })

  it('holds `vp run ready` — it type-checks (`vp lint`) before it packs', () => {
    expect(heldReason(runHook('ready', 'vp run ready'))).toBeDefined()
    // The retry runs, and it does pack, so it satisfies later checks.
    expect(heldReason(runHook('ready', 'vp run ready'))).toBeUndefined()
    expect(heldReason(runHook('ready', 'vp check'))).toBeUndefined()
  })

  it('honors a build earlier in the same command line', () => {
    expect(heldReason(runHook('same-line', 'vp run pack && vp check'))).toBeUndefined()
  })

  it('still holds when the check comes before the build on one command line', () => {
    expect(heldReason(runHook('wrong-order', 'vp check && vp run pack'))).toBeDefined()
  })

  it('holds `vp run check` too — the per-package script is `vp check`', () => {
    expect(heldReason(runHook('run-check', 'vp run check'))).toBeDefined()
  })

  it('recognizes the workspace-local binary', () => {
    expect(heldReason(runHook('local-bin', 'node_modules/.bin/vp check'))).toBeDefined()
  })

  it.each([['vp run lint:docs'], ['vp install'], ['vp test'], ['git status'], ['./scripts/x.sh']])(
    'ignores `%s` — neither a build nor a check',
    (unrelated) => {
      // A real session id is a uuid; the hook flattens anything else so a
      // command-derived id like this one still keys a writable state file.
      const session = `unrelated-${unrelated}`
      expect(heldReason(runHook(session, unrelated))).toBeUndefined()
      // The unrelated command must not have satisfied the build requirement.
      expect(heldReason(runHook(session, 'vp check'))).toBeDefined()
    }
  )

  it.each([
    // Caught in the wild: committing this hook held its own `git commit`,
    // because the message heredoc talks about `vp check`.
    ["git commit -F - <<'EOF'\nHold the first vp check\nEOF"],
    // A heredoc body line that *starts* with the command is still data, both
    // when it names a check (a false hold that also burns the session's one
    // reminder)...
    ["git commit -F - <<'EOF'\nvp check now waits for a pack\nEOF"],
    // ...and when it names a build (which would silently satisfy the hold).
    ["cat > notes.md <<'EOF'\nvp run pack\nEOF"],
    // Separators inside quotes don't start a new command either.
    ['git commit -m "fix: pack first\nvp check waits for a pack"'],
    ['echo "run vp check first"'],
    ['grep -n "vp check" AGENTS.md'],
  ])('ignores `vp` outside command position in `%s`', (prose) => {
    // Hashed, not sliced: several of these rows share a `git commit -` prefix,
    // and a shared session id would let one row's state leak into the next.
    const session = `prose-${createHash('sha1').update(prose).digest('hex').slice(0, 12)}`
    expect(heldReason(runHook(session, prose))).toBeUndefined()
    // ...and prose naming a build must not satisfy the requirement either.
    expect(heldReason(runHook(session, 'vp check'))).toBeDefined()
  })

  it('still sees a `vp` behind leading env assignments', () => {
    expect(heldReason(runHook('env-prefix', 'CI=1 vp check'))).toBeDefined()
  })

  it('reads a newline-separated script line by line', () => {
    expect(heldReason(runHook('newlines', 'vp run pack\nvp check'))).toBeUndefined()
  })

  it('ignores non-Bash tools', () => {
    expect(heldReason(runHook('non-bash', 'vp check', 'Read'))).toBeUndefined()
  })

  it('fails open on input it cannot understand', () => {
    // A Bash call whose tool_input carries no command string.
    expect(heldReason(runHook('no-command', 'vp check', 'Bash', {}))).toBeUndefined()
    const output = execFileSync(process.execPath, [hookPath], {
      input: 'not json',
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: stateHome, TEMP: stateHome, TMP: stateHome },
    })
    expect(output.trim()).toBe('')
  })

  it('holds the first check regardless of the flags it carries', () => {
    let session = 0
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('--fix', '-r', '--cache', '--filter', 'kitchen-sink'), {
          maxLength: 4,
        }),
        (extras) => {
          session += 1
          const command = ['vp', 'check', ...extras].join(' ')
          expect(heldReason(runHook(`flags-${session}`, command))).toBeDefined()
        }
      ),
      // Each run spawns a node process, so keep the count low.
      { numRuns: numRunsFor({ base: 12 }) }
    )
  })
})
