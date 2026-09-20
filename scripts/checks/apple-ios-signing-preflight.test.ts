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

describe('identity_kind', () => {
  // Apple renamed these kinds but still issues and accepts the old spellings,
  // so a check that knows only the current names rejects working certificates.
  it.each([
    ['Apple Distribution: Wildflower Health (29QHKJX9V7)', 'distribution'],
    ['iPhone Distribution: Wildflower Health', 'distribution'],
    ['Apple Development: ryanmarks@mac.com (X7NW4R3H9Y)', 'development'],
    ['iPhone Developer: ryanmarks@mac.com', 'development'],
    ['Developer ID Application: Wildflower Health', 'developer-id'],
    ['Mac Developer: someone', 'other'],
  ])('reads %j as %s', (name, expected) => {
    expect(callHelper('identity_kind', name)).toBe(expected)
  })

  // The distinction the iOS release turns on: a Developer ID certificate is
  // right for the notarized macOS bundle and useless for App Store upload,
  // and the two live in sibling secrets, so mixing them up is easy.
  it('does not accept the macOS Developer ID certificate as a distribution one', () => {
    expect(callHelper('identity_kind', 'Developer ID Application: Wildflower Health')).not.toBe(
      'distribution'
    )
  })
})

describe('profile_kind', () => {
  it.each([
    // provisions_all, has_devices, get_task_allow
    ['false', 'false', 'false', 'app-store'],
    ['false', 'true', 'true', 'development'],
    ['false', 'true', 'false', 'ad-hoc'],
    ['true', 'false', 'false', 'enterprise'],
  ])('(%s, %s, %s) is a %s profile', (all, devices, taskAllow, expected) => {
    expect(callHelper('profile_kind', all, devices, taskAllow)).toBe(expected)
  })

  // An enterprise profile omits ProvisionedDevices exactly like an App Store
  // one, so it is only distinguishable by ProvisionsAllDevices being checked
  // first. Get the order wrong and an enterprise profile silently passes as
  // App Store, failing much later inside xcodebuild.
  it('does not mistake an enterprise profile for an App Store one', () => {
    expect(callHelper('profile_kind', 'true', 'false', 'false')).toBe('enterprise')
  })

  // The profile the failing build actually wanted. Naming it 'development'
  // is what lets the error message connect to Xcode's own wording about
  // "iOS App Development provisioning profiles".
  it('identifies the development profile automatic signing looks for', () => {
    expect(callHelper('profile_kind', 'false', 'true', 'true')).toBe('development')
  })
})
