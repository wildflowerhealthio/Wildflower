import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vite-plus/test'

// Pure bash helpers shared by the iOS and macOS App Store preflights. Sourcing
// the library defines them with no I/O, so they run anywhere.
const libPath = join(dirname(fileURLToPath(import.meta.url)), 'apple-signing-lib.sh')

const callHelper = (fn: string, ...args: ReadonlyArray<string>): string =>
  execFileSync('bash', ['-c', `source "$0"; ${fn} "\${@:2}"`, libPath, '--', ...args], {
    encoding: 'utf8',
  }).trim()

describe('identity_kind', () => {
  it.each([
    // Apple renamed these kinds but still issues and accepts the old
    // spellings, so a check that knows only the current names rejects
    // working certificates.
    ['Apple Distribution: Wildflower Health (29QHKJX9V7)', 'distribution'],
    ['iPhone Distribution: Wildflower Health', 'distribution'],
    ['3rd Party Mac Developer Application: Wildflower Health', 'distribution'],
    ['3rd Party Mac Developer Installer: Wildflower Health', 'mac-installer'],
    ['Mac Installer Distribution: Wildflower Health', 'mac-installer'],
    ['Apple Development: ryanmarks@mac.com (X7NW4R3H9Y)', 'development'],
    ['iPhone Developer: ryanmarks@mac.com', 'development'],
    ['Mac Developer: ryanmarks@mac.com', 'development'],
    ['Developer ID Application: Wildflower Health', 'developer-id'],
    ['Developer ID Installer: Wildflower Health', 'developer-id-installer'],
    ['Some Other Cert: x', 'other'],
  ])('reads %j as %s', (name, expected) => {
    expect(callHelper('identity_kind', name)).toBe(expected)
  })

  // The three certificates in play differ by one word and are each valid for
  // a different channel, so conflating any pair produces a rejection far from
  // its cause. These are the pairs most easily mixed up.
  it('separates the app, installer and Developer ID certificates', () => {
    const appStoreApp = callHelper('identity_kind', 'Apple Distribution: Wildflower Health')
    const appStoreInstaller = callHelper(
      'identity_kind',
      '3rd Party Mac Developer Installer: Wildflower Health'
    )
    const directDownload = callHelper(
      'identity_kind',
      'Developer ID Application: Wildflower Health'
    )
    expect(new Set([appStoreApp, appStoreInstaller, directDownload]).size).toBe(3)
  })

  // The GitHub Release build's certificate is the one already sitting in the
  // repo's secrets, so it is the likeliest wrong answer for a TestFlight job.
  it('does not accept a Developer ID certificate as an App Store one', () => {
    expect(callHelper('identity_kind', 'Developer ID Application: Wildflower Health')).not.toBe(
      'distribution'
    )
    expect(callHelper('identity_kind', 'Developer ID Installer: Wildflower Health')).not.toBe(
      'mac-installer'
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
  // App Store, failing much later inside the upload.
  it('does not mistake an enterprise profile for an App Store one', () => {
    expect(callHelper('profile_kind', 'true', 'false', 'false')).toBe('enterprise')
  })
})
