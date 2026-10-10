import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

// Unlike the Apple preflights, nothing here needs macOS: the suite runs the
// whole script against keystores keytool makes in beforeAll, and calls its
// helpers by sourcing it — which returns early, defining them without running
// the preflight.
const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'android-play-preflight.sh')

const callHelper = (fn: string, ...args: ReadonlyArray<string>): string =>
  execFileSync('bash', ['-c', `source "$0"; ${fn} "\${@:2}"`, scriptPath, '--', ...args], {
    encoding: 'utf8',
  }).trim()

const password = 'store-password'
const serviceAccount = JSON.stringify({
  type: 'service_account',
  client_email: 'release@wildflower.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
})

let dir: string
const keystores: Record<string, string> = {}

const keytool = (...args: ReadonlyArray<string>): void => {
  execFileSync('keytool', args, { stdio: 'ignore' })
}

const genkey = (
  name: string,
  opts: { storetype?: string; keyPassword?: string; extra?: ReadonlyArray<string> } = {}
): void => {
  const path = join(dir, `${name}.jks`)
  keytool(
    '-genkeypair',
    '-keystore',
    path,
    ...(opts.storetype ? ['-storetype', opts.storetype] : []),
    '-alias',
    'upload',
    '-keyalg',
    'RSA',
    '-keysize',
    '2048',
    '-dname',
    'CN=Test upload',
    '-storepass',
    password,
    '-keypass',
    opts.keyPassword ?? password,
    ...(opts.extra ?? ['-validity', '365'])
  )
  keystores[name] = path
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'android-play-preflight-'))
  genkey('good')
  // JKS keeps a key password of its own; PKCS12 cannot.
  genkey('split-password', { storetype: 'JKS', keyPassword: 'key-password' })
  genkey('expired', { extra: ['-startdate', '-2y', '-validity', '1'] })
  // A store holding only the certificate, as `-importcert` leaves it.
  const pem = join(dir, 'upload.pem')
  keytool(
    '-exportcert',
    '-rfc',
    '-keystore',
    keystores.good,
    '-alias',
    'upload',
    '-storepass',
    password,
    '-file',
    pem
  )
  keystores['certificate-only'] = join(dir, 'certificate-only.jks')
  keytool(
    '-importcert',
    '-noprompt',
    '-keystore',
    keystores['certificate-only'],
    '-alias',
    'upload',
    '-file',
    pem,
    '-storepass',
    password
  )
  writeFileSync(join(dir, 'not-a-keystore.jks'), 'not a keystore\n')
  keystores['not-a-keystore'] = join(dir, 'not-a-keystore.jks')
}, 60_000)

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const preflight = (
  env: Partial<Record<string, string>> = {}
): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync('bash', [scriptPath], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      ANDROID_UPLOAD_KEYSTORE: readFileSync(keystores.good).toString('base64'),
      ANDROID_UPLOAD_KEYSTORE_PASSWORD: password,
      ANDROID_UPLOAD_KEY_ALIAS: 'upload',
      PLAY_SERVICE_ACCOUNT_JSON: serviceAccount,
      ...env,
    },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const keystore = (name: string): string => readFileSync(keystores[name]).toString('base64')

describe('keytool_failure_kind', () => {
  it.each([
    ['keytool error: java.io.IOException: keystore password was incorrect', 'password'],
    [
      'keytool error: java.io.IOException: Keystore was tampered with, or password was incorrect',
      'password',
    ],
    [
      'keytool error: java.security.KeyStoreException: Unrecognized keystore format. Please load it with a specified type',
      'format',
    ],
    ['keytool error: java.io.IOException: Invalid keystore format', 'format'],
    ['keytool error: java.io.FileNotFoundException: upload.jks', 'other'],
  ])('reads %s as %s', (output, kind) => {
    expect(callHelper('keytool_failure_kind', output)).toBe(kind)
  })
})

describe('keystore_entry_kind', () => {
  it.each([
    ['upload, Oct 10, 2026, PrivateKeyEntry, ', 'private-key'],
    ['upload, Oct 10, 2026, trustedCertEntry, ', 'certificate'],
    ['upload, Oct 10, 2026, SecretKeyEntry, ', 'other'],
  ])('reads %s as %s', (listing, kind) => {
    expect(callHelper('keystore_entry_kind', listing)).toBe(kind)
  })
})

describe('service_account_email', () => {
  const check = (json: string): { out: string; err: string; code: number } => {
    const path = join(dir, 'service-account.json')
    writeFileSync(path, json)
    const result = spawnSync(
      'bash',
      ['-c', 'source "$0"; service_account_email "$1"', scriptPath, path],
      { encoding: 'utf8' }
    )
    return { out: result.stdout.trim(), err: result.stderr.trim(), code: result.status ?? -1 }
  }

  it('echoes the client email of a service account key', () => {
    expect(check(serviceAccount)).toEqual({
      out: 'release@wildflower.iam.gserviceaccount.com',
      err: '',
      code: 0,
    })
  })

  // An OAuth client or a user's application-default credentials parse as
  // JSON too, and authenticate as something Play Console never invited.
  it.each([
    ['{"type":"authorized_user","client_email":"a@b"}', "has type 'authorized_user'"],
    ['{"type":"service_account","private_key":"k"}', 'has no client_email'],
    ['{"type":"service_account","client_email":"a@b"}', 'has no private_key'],
    ['[]', 'is JSON but not an object'],
    ['not json', 'is not JSON'],
  ])('refuses %s', (json, reason) => {
    const result = check(json)
    expect(result.code).not.toBe(0)
    expect(result.err).toContain(reason)
  })
})

describe('android-play-preflight', { timeout: 30_000 }, () => {
  it('passes a keystore, password, alias and service account that fit together', () => {
    const result = preflight()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(
      "OK — upload key 'upload' and service account release@wildflower.iam.gserviceaccount.com"
    )
    expect(result.stdout).toMatch(/certificate SHA-256 (?:[0-9A-F]{2}:){31}[0-9A-F]{2}\./)
  })

  it.each([
    ['ANDROID_UPLOAD_KEYSTORE'],
    ['ANDROID_UPLOAD_KEYSTORE_PASSWORD'],
    ['ANDROID_UPLOAD_KEY_ALIAS'],
    ['PLAY_SERVICE_ACCOUNT_JSON'],
  ])('names an empty %s', (name) => {
    const result = preflight({ [name]: '' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`::error::${name} is empty.`)
  })

  it('refuses a keystore that is not base64', () => {
    const result = preflight({ ANDROID_UPLOAD_KEYSTORE: '!!!' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('ANDROID_UPLOAD_KEYSTORE is not valid base64')
  })

  it('tells a wrong password apart from a file that is not a keystore', () => {
    const wrong = preflight({ ANDROID_UPLOAD_KEYSTORE_PASSWORD: 'wrong-password' })
    expect(wrong.status).toBe(1)
    expect(wrong.stderr).toContain(
      'ANDROID_UPLOAD_KEYSTORE_PASSWORD does not open ANDROID_UPLOAD_KEYSTORE'
    )
    const garbage = preflight({ ANDROID_UPLOAD_KEYSTORE: keystore('not-a-keystore') })
    expect(garbage.status).toBe(1)
    expect(garbage.stderr).toContain('ANDROID_UPLOAD_KEYSTORE decodes, but not to a keystore')
  })

  it('lists the aliases the keystore does hold when the alias is wrong', () => {
    const result = preflight({ ANDROID_UPLOAD_KEY_ALIAS: 'release' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("has no entry named 'release'")
    expect(result.stderr).toContain('It holds:\n  upload')
  })

  it('refuses an alias that holds only a certificate', () => {
    const result = preflight({ ANDROID_UPLOAD_KEYSTORE: keystore('certificate-only') })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      "'upload' in ANDROID_UPLOAD_KEYSTORE is not a private key entry"
    )
  })

  // keystore.properties has one password for both; a JKS key with its own
  // opens the store and then fails the signing step at the end of the build.
  it('refuses a key whose password differs from the store password', () => {
    const result = preflight({ ANDROID_UPLOAD_KEYSTORE: keystore('split-password') })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("opens the keystore but not the key 'upload'")
  })

  it('refuses an expired upload certificate', () => {
    const result = preflight({ ANDROID_UPLOAD_KEYSTORE: keystore('expired') })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("The upload certificate for 'upload' expired on")
  })

  it('refuses a password keystore.properties would read differently', () => {
    const result = preflight({ ANDROID_UPLOAD_KEYSTORE_PASSWORD: 'back\\slash' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('contains a backslash')
  })

  it('refuses a service account key that is not one', () => {
    const result = preflight({ PLAY_SERVICE_ACCOUNT_JSON: '{"type":"authorized_user"}' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      "PLAY_SERVICE_ACCOUNT_JSON has type 'authorized_user', not 'service_account'"
    )
  })
})
