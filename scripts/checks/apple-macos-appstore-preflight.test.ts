import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vite-plus/test'

// Everything past the helpers needs macOS, so the suite sources the script —
// which returns early — and checks the wiring it can verify on Linux.
const here = dirname(fileURLToPath(import.meta.url))
const scriptPath = join(here, 'apple-macos-appstore-preflight.sh')

const source = (): string => execFileSync('cat', [scriptPath], { encoding: 'utf8' })

describe('apple-macos-appstore-preflight', () => {
  // Sourcing must pull in the shared library, or the script would reference
  // identity_kind/profile_kind that were never defined and die at runtime on
  // the one machine that can actually run it.
  it('exposes the shared helpers when sourced', () => {
    const out = execFileSync(
      'bash',
      [
        '-c',
        `source "$0"; identity_kind "Apple Distribution: X"; profile_kind false false false`,
        scriptPath,
      ],
      { encoding: 'utf8' }
    ).trim()
    expect(out.split('\n')).toEqual(['distribution', 'app-store'])
  })

  // Sourcing must stop before the preflight body: the test runner would
  // otherwise execute a check that creates keychains.
  it('does not run the preflight body when sourced', () => {
    const out = execFileSync('bash', ['-c', `source "$0"; echo sourced-cleanly`, scriptPath], {
      encoding: 'utf8',
    }).trim()
    expect(out).toBe('sourced-cleanly')
  })

  // An installer certificate carries no codesigning policy, so
  // `find-identity -p codesigning` cannot see it. Resolving it under the
  // wrong policy would report a perfectly good certificate as missing — the
  // exact false negative this check exists to avoid.
  it('resolves installer identities under the basic policy', () => {
    expect(source()).toMatch(/want_kind" == mac-installer \]\] && policy=basic/)
  })

  // Every required input is named individually, because GitHub interpolates
  // an unset variable to an empty string and a combined check could not say
  // which one is missing.
  it.each([
    'MACOS_APPSTORE_CERTIFICATE',
    'MACOS_APPSTORE_CERTIFICATE_PASSWORD',
    'MACOS_INSTALLER_CERTIFICATE',
    'MACOS_INSTALLER_CERTIFICATE_PASSWORD',
    'MACOS_PROVISIONING_PROFILE',
    'APPLE_TEAM_ID',
  ])('rejects an empty %s by name', (variable) => {
    expect(source()).toMatch(
      new RegExp(`\\[\\[ -n "\\$\\{?\\w+\\}?" \\]\\] \\|\\| fail "${variable} is empty`)
    )
  })
})
