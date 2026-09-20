import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
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

describe('plist_keypath', () => {
  // `plutil -extract` splits a keypath on ".", so the dots inside a
  // reverse-DNS entitlement key have to be escaped or plutil walks four
  // nested keys that do not exist and reports nothing at all.
  it('escapes the dots inside a key name', () => {
    expect(callHelper('plist_keypath', 'Entitlements', 'com.apple.application-identifier')).toBe(
      String.raw`Entitlements.com\.apple\.application-identifier`
    )
  })

  // One argument per path component: the separators this joins on are the
  // only unescaped dots in the result.
  it('joins components with an unescaped separator', () => {
    expect(callHelper('plist_keypath', 'ProvisionedDevices', '0')).toBe('ProvisionedDevices.0')
  })

  it('leaves a dot-free key untouched', () => {
    expect(callHelper('plist_keypath', 'Entitlements', 'get-task-allow')).toBe(
      'Entitlements.get-task-allow'
    )
  })
})

// The preflights inject their plutil-backed reader into read_app_identifier,
// so these drive the real branching with a stub reader standing in for
// plutil. The stub answers only the keypath it is told to, which is what lets
// an unescaped lookup be observed as the miss it is.
const readAppIdentifier = (respondsTo: string, value: string): { out: string; code: number } => {
  // bash reports the exit code on stdout rather than exiting non-zero, so a
  // miss — which is the interesting case here — stays an ordinary result
  // instead of an exception whose shape would have to be asserted.
  const script = [
    'source "$0"',
    `reader() { [[ "$1" == "$RESPONDS_TO" ]] && printf '%s\\n' "$VALUE"; return 0; }`,
    'if out="$(read_app_identifier reader)"; then code=0; else code=$?; fi',
    `printf '%s %s' "$code" "$out"`,
  ].join('; ')
  const raw = execFileSync('bash', ['-c', script, libPath], {
    encoding: 'utf8',
    env: { ...process.env, RESPONDS_TO: respondsTo, VALUE: value },
  })
  const separator = raw.indexOf(' ')
  return { out: raw.slice(separator + 1).trim(), code: Number(raw.slice(0, separator)) }
}

const APP_ID = '29QHKJX9V7.io.wildflowerhealth.hostapp'

describe('read_app_identifier', () => {
  // A macOS profile carries only the namespaced spelling and an iOS profile
  // only the bare one, so a check that knows one spelling fails on the other
  // platform's profile.
  it.each([
    ['macOS', String.raw`Entitlements.com\.apple\.application-identifier`],
    ['iOS', 'Entitlements.application-identifier'],
  ])('reads the %s spelling', (_platform, keypath) => {
    expect(readAppIdentifier(keypath, APP_ID)).toEqual({ out: APP_ID, code: 0 })
  })

  // The regression under test. Before the escaping, the macOS key was asked
  // for as an unescaped keypath, which plutil reads as four nested keys; the
  // empty result was then compared against the bundle id and reported as a
  // mismatched profile, sending you to regenerate a profile that was correct.
  it('does not ask for the namespaced key as an unescaped keypath', () => {
    expect(readAppIdentifier('Entitlements.com.apple.application-identifier', APP_ID)).toEqual({
      out: '',
      code: 1,
    })
  })

  // A miss has to be distinguishable from a read, or callers cannot tell "no
  // such entitlement" from "the entitlement is the empty string".
  it('reports a miss rather than an empty identifier', () => {
    expect(readAppIdentifier('Entitlements.something-else', APP_ID)).toEqual({ out: '', code: 1 })
  })
})

// The inverse of plist_keypath, written the way plutil documents reading one:
// split on dots that are not backslash-escaped, then unescape.
const splitKeypath = (keypath: string): ReadonlyArray<string> => {
  const parts: string[] = []
  let current = ''
  for (let index = 0; index < keypath.length; index += 1) {
    const char = keypath[index]
    if (char === '\\' && keypath[index + 1] === '.') {
      current += '.'
      index += 1
    } else if (char === '.') {
      parts.push(current)
      current = ''
    } else {
      current += char
    }
  }
  return [...parts, current]
}

// plist_keypath emits exactly one trailing newline. The shared callHelper
// trims, which would also eat a key's own leading or trailing spaces — so
// this strips just that newline and leaves the value as the function wrote it.
const keypathOf = (components: ReadonlyArray<string>): string =>
  execFileSync(
    'bash',
    ['-c', `source "$0"; plist_keypath "\${@:2}"`, libPath, '--', ...components],
    { encoding: 'utf8' }
  ).replace(/\n$/, '')

describe('plist_keypath round-trip', () => {
  // The example tests pin the two spellings in play today. This pins the rule
  // behind them: whatever the key names, a plutil-style reader gets back the
  // components that went in. It fails on too little escaping (a dotted key
  // splits into extra components) and on too much (a separator stops
  // splitting), which the examples alone cannot both catch.
  const keyName = fc
    .string({ minLength: 1, maxLength: 24 })
    .filter((key) => !/[\\\n\r\0]/.test(key))

  it('recovers the components a plutil-style reader splits back out', () => {
    fc.assert(
      fc.property(fc.array(keyName, { minLength: 1, maxLength: 4 }), (components) => {
        expect(splitKeypath(keypathOf(components))).toEqual(components)
      }),
      // Each run spawns a bash process, so this buys breadth more cheaply at
      // a lower count than the repo-wide default.
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})
