import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vite-plus/test'

// The script under test is bash and all but its helper functions need macOS,
// so the suite sources it — which returns early, defining the helpers without
// running the preflight — and calls `classify_notary_failure` directly.
const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'apple-signing-preflight.sh')

const classify = (notarytoolStderr: string): string =>
  execFileSync(
    'bash',
    ['-c', `source "$0"; classify_notary_failure "$1"`, scriptPath, notarytoolStderr],
    { encoding: 'utf8' }
  ).trim()

// Copied verbatim from the release run that prompted this fix, newlines
// flattened the way the script flattens them before classifying. Its shape is
// the whole point: notarytool answers a bad flag by printing every flag it
// *does* take, `[--password <password>]` among them — so a classifier that
// looks for credential words first reads a usage error as a rejected password
// and tells the release engineer to rotate a working secret.
const PAGE_SIZE_USAGE_DUMP =
  "Error: Unknown option '--page-size' Usage: notarytool global-options " +
  'app-store-connect-options app-specific-password-options keychain-options ' +
  'credential-options output-options history [--verbose ...] [--key <key>] ' +
  '[--key-id <key-id>] [--issuer <issuer>] [--apple-id <apple-id>] ' +
  '[--password <password>] [--team-id <team-id>] [--keychain-profile ' +
  '<keychain-profile>] [--keychain <keychain>] [--output-format ' +
  '<output-format>] [--progress] [--no-progress]'

describe('classify_notary_failure', () => {
  it('reads the --page-size regression as a usage error, not a credential one', () => {
    expect(classify(PAGE_SIZE_USAGE_DUMP)).toBe('usage')
  })

  it.each([
    ["Error: Unknown option '--page-size'", 'usage'],
    ['Error: Missing expected argument for --team-id', 'usage'],
    ['Error: HTTP status code: 401. Unable to authenticate.', 'auth'],
    ['Error: HTTP status code: 403. Forbidden.', 'auth'],
    ['Error: Invalid credentials. Username or password is incorrect.', 'auth'],
    ['Error: Could not connect to the notary service.', 'network'],
    ['Error: The request timed out.', 'network'],
    ['Error: HTTP status code: 503. Service unavailable.', 'network'],
  ])('classifies %j as %s', (stderr, expected) => {
    expect(classify(stderr)).toBe(expected)
  })

  // Anything unrecognised must not be asserted to be a bad password: the
  // caller turns `unknown` into a message that says the cause is unclear.
  it('does not guess at an unfamiliar failure', () => {
    expect(classify('Error: the notary service returned an unexpected shape')).toBe('unknown')
  })
})

describe('the notarytool invocation', () => {
  // A regression guard with a real cost behind it: `--page-size` is not an
  // option `notarytool history` accepts, and passing one meant the check
  // failed identically whether the secrets were valid or expired.
  it('passes no --page-size flag', () => {
    // Comment lines are stripped first: the script explains the regression in
    // prose, and the guard is about what the script *runs*.
    const code = execFileSync('cat', [scriptPath], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    expect(code).not.toMatch(/--page-size/)
  })
})
