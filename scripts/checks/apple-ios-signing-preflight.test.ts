import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vite-plus/test'

// The script is bash and everything past its helpers needs macOS, so the
// suite sources it — which returns early, defining the helpers without
// running the preflight — and calls them directly.
const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'apple-ios-signing-preflight.sh')

const callHelper = (fn: string, ...args: ReadonlyArray<string>): string =>
  execFileSync('bash', ['-c', `source "$0"; ${fn} "\${@:2}"`, scriptPath, '--', ...args], {
    encoding: 'utf8',
  }).trim()

// The exhaustive classification tables live in apple-signing-lib.test.ts, next
// to the helpers themselves. What matters here is that the iOS preflight
// actually reaches them, and the two distinctions the iOS channel turns on.
describe('apple-ios-signing-preflight', () => {
  it('exposes the shared helpers when sourced', () => {
    expect(callHelper('identity_kind', 'Apple Distribution: Wildflower Health')).toBe(
      'distribution'
    )
    expect(callHelper('profile_kind', 'false', 'false', 'false')).toBe('app-store')
  })

  // A Developer ID certificate is right for the notarized macOS bundle and
  // useless for App Store upload, and the two live in sibling secrets.
  it('does not accept the macOS Developer ID certificate as a distribution one', () => {
    expect(callHelper('identity_kind', 'Developer ID Application: Wildflower Health')).not.toBe(
      'distribution'
    )
  })

  // The profile automatic signing falls back to looking for. Naming it
  // 'development' is what lets the error message connect to Xcode's own
  // wording about "iOS App Development provisioning profiles".
  it('identifies the development profile automatic signing looks for', () => {
    expect(callHelper('profile_kind', 'false', 'true', 'true')).toBe('development')
  })
})
