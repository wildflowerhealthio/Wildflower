import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vite-plus/test'

// Everything past the helpers needs macOS, so the suite sources the script —
// which returns early — and checks the wiring it can verify on Linux.
const here = dirname(fileURLToPath(import.meta.url))
const scriptPath = join(here, 'apple-app-record-preflight.sh')

const run = (script: string): string =>
  execFileSync('bash', ['-c', script, scriptPath], { encoding: 'utf8' }).trim()

describe('apple-app-record-preflight', () => {
  // Sourcing must pull in the shared library, or the script would reference
  // an app_record_verdict that was never defined and die at runtime on the
  // one machine that can actually run it.
  it('exposes the shared helpers when sourced', () => {
    expect(run(`source "$0"; app_record_verdict io.example.app "io.example.app"`)).toBe('present')
  })

  // Sourcing must stop before the body: the test runner would otherwise
  // reach out to App Store Connect.
  it('does not run the preflight body when sourced', () => {
    expect(run(`source "$0"; echo sourced-cleanly`)).toBe('sourced-cleanly')
  })

  // The suite runs on Linux, where there is no xcrun. Skipping has to be a
  // pass, not an error, or every non-macOS run of the checks fails.
  it('skips instead of failing off macOS', () => {
    expect(run(`"$0"`)).toContain('skipping')
  })
})

const verdict = (wanted: string, found: string): string =>
  execFileSync(
    'bash',
    [
      '-c',
      `source "$0"; app_record_verdict "$1" "$2"`,
      join(here, 'apple-signing-lib.sh'),
      wanted,
      found,
    ],
    { encoding: 'utf8' }
  ).trim()

describe('app_record_verdict', () => {
  it('finds the bundle id among several records', () => {
    expect(verdict('io.example.app', 'com.other.thing\nio.example.app\ncom.third.thing')).toBe(
      'present'
    )
  })

  it('reports a bundle id missing from a populated list', () => {
    expect(verdict('io.example.app', 'com.other.thing\ncom.third.thing')).toBe('absent')
  })

  // The distinction the whole three-valued design exists for. An empty answer
  // means the question could not be asked — an altool shape this does not
  // know, a transient error — and calling that `absent` would fail a release
  // because the check itself broke. That is the failure mode that produced
  // this PR, so it gets its own test rather than riding on the empty case.
  it.each([
    ['an empty answer', ''],
    ['a whitespace-only answer', '  \n  '],
  ])('treats %s as unknown rather than absent', (_label, found) => {
    expect(verdict('io.example.app', found)).toBe('unknown')
  })

  // A prefix is not a match: two apps can share a bundle id prefix, and
  // accepting one for the other would pass a check the upload then fails.
  it('does not accept a prefix or suffix as the record', () => {
    expect(verdict('io.example.app', 'io.example.app.helper')).toBe('absent')
    expect(verdict('io.example.app', 'staging.io.example.app')).toBe('absent')
  })
})
