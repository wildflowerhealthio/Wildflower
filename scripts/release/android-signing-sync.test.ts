import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test'

// The script talks to the world only through gh, so a fake for it goes first
// on PATH; keytool, openssl and the preflight are the real ones.
//
// The fake gh logs each call's arguments, and for `secret set` /
// `variable set` the value it read from stdin, into
// FAKE_DIR/github/<env>/<name>. A PUT of the environment logs the body it
// read from stdin into FAKE_DIR/environment.json.
const here = dirname(fileURLToPath(import.meta.url))
const scriptPath = join(here, 'android-signing-sync.sh')

const fakeGh = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DIR/gh.log"
case "$1 $2" in
  "auth status") exit 0 ;;
  "repo view") echo wildflower/test-repo ;;
  "secret set"|"variable set")
    mkdir -p "$FAKE_DIR/github/$5"
    cat > "$FAKE_DIR/github/$5/$3"
    ;;
  api*)
    if [[ "$2 $3" == "-X PUT" ]]; then
      cat > "$FAKE_DIR/environment.json"
      exit 0
    fi
    # GET of a missing environment fails; PUT and POST create.
    [[ "$2" == -X ]] || [[ -n "\${FAKE_ENVIRONMENTS_EXIST:-}" ]] || exit 1
    ;;
esac
`

const serviceAccount = JSON.stringify({
  type: 'service_account',
  client_email: 'release@wildflower.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
})

let dir: string
let fake: string
let signing: string
let pool: string

// keytool's key generation dominates the run time, so one upload keystore is
// made once and copied into the tests that start from an existing key.
beforeAll(() => {
  pool = mkdtempSync(join(tmpdir(), 'android-signing-sync-keys-'))
  writeFileSync(join(pool, 'android-upload.password'), 'existing-password')
  execFileSync(
    'keytool',
    [
      '-genkeypair',
      '-keystore',
      join(pool, 'android-upload.jks'),
      '-alias',
      'upload',
      '-keyalg',
      'RSA',
      '-keysize',
      '2048',
      '-validity',
      '365',
      '-dname',
      'CN=Existing upload',
      '-storepass',
      'existing-password',
      '-keypass',
      'existing-password',
    ],
    { stdio: 'ignore' }
  )
}, 60_000)

afterAll(() => {
  rmSync(pool, { recursive: true, force: true })
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'android-signing-sync-'))
  fake = join(dir, 'fake')
  signing = join(dir, 'signing')
  mkdirSync(join(dir, 'bin'))
  mkdirSync(fake)
  mkdirSync(signing)
  writeFileSync(join(dir, 'bin', 'gh'), fakeGh)
  chmodSync(join(dir, 'bin', 'gh'), 0o755)
  writeFileSync(join(signing, 'play-service-account.json'), serviceAccount)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const useExistingKey = (): void => {
  for (const name of ['android-upload.jks', 'android-upload.password'])
    copyFileSync(join(pool, name), join(signing, name))
}

const sync = (
  args: ReadonlyArray<string> = [],
  env: Record<string, string> = {}
): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync('bash', [scriptPath, ...args], {
    encoding: 'utf8',
    input: '',
    env: {
      PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: dir,
      FAKE_DIR: fake,
      WILDFLOWER_SIGNING_DIR: signing,
      ...env,
    },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const ghLog = (): string =>
  existsSync(join(fake, 'gh.log')) ? readFileSync(join(fake, 'gh.log'), 'utf8') : ''

const stored = (name: string): string =>
  readFileSync(join(fake, 'github', 'android-play', name), 'utf8')

const storedNames = (): ReadonlyArray<string> =>
  ghLog()
    .split('\n')
    .filter((line) => / set /.test(` ${line} `) && line.includes('--env android-play'))
    .map((line) => line.split(' ')[2])
    .toSorted()

// Opens the stored keystore with the stored password and alias, as the
// workflow's keystore.properties has Gradle do, and returns the certificate.
const storedCertificate = (): string => {
  const keystore = join(dir, 'stored.jks')
  writeFileSync(keystore, Buffer.from(stored('ANDROID_UPLOAD_KEYSTORE'), 'base64'))
  return execFileSync(
    'keytool',
    [
      '-exportcert',
      '-rfc',
      '-keystore',
      keystore,
      '-alias',
      stored('ANDROID_UPLOAD_KEY_ALIAS'),
      '-storepass:env',
      'STORED_PASSWORD',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, STORED_PASSWORD: stored('ANDROID_UPLOAD_KEYSTORE_PASSWORD') },
    }
  )
}

// Each test runs the whole script, keytool and the preflight included, which
// outlasts the default timeout on a loaded runner.
describe('android-signing-sync', { timeout: 30_000 }, () => {
  it('generates the upload key on a first run and stores everything in android-play', () => {
    const result = sync()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(
      `Generated a new upload key at ${join(signing, 'android-upload.jks')}.`
    )

    expect(storedNames()).toEqual([
      'ANDROID_UPLOAD_KEYSTORE',
      'ANDROID_UPLOAD_KEYSTORE_PASSWORD',
      'ANDROID_UPLOAD_KEY_ALIAS',
      'PLAY_SERVICE_ACCOUNT_JSON',
    ])
    expect(stored('ANDROID_UPLOAD_KEY_ALIAS')).toBe('upload')
    expect(stored('PLAY_SERVICE_ACCOUNT_JSON')).toBe(serviceAccount)
    expect(stored('ANDROID_UPLOAD_KEYSTORE_PASSWORD')).toBe(
      readFileSync(join(signing, 'android-upload.password'), 'utf8')
    )
    // The stored keystore opens with the stored password, and its certificate
    // is the one written beside the key for an upload key reset.
    expect(storedCertificate().trim()).toBe(
      readFileSync(join(signing, 'android-upload.pem'), 'utf8').trim()
    )
  })

  it('creates a missing environment that deploys from main only', () => {
    expect(sync().status).toBe(0)
    expect(JSON.parse(readFileSync(join(fake, 'environment.json'), 'utf8'))).toEqual({
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    })
    expect(ghLog()).toContain(
      'api -X POST repos/{owner}/{repo}/environments/android-play/deployment-branch-policies -f name=main -f type=branch --silent'
    )
  })

  // Its protection rules may have been changed by hand since.
  it('leaves an existing environment as it is', () => {
    expect(sync([], { FAKE_ENVIRONMENTS_EXIST: '1' }).status).toBe(0)
    expect(ghLog()).not.toContain('-X PUT')
    expect(ghLog()).not.toContain('-X POST')
  })

  // Play Console refuses bundles from any other upload key, so the one in
  // the signing folder is never replaced.
  it('reuses the upload key in the signing folder', () => {
    useExistingKey()
    const before = readFileSync(join(signing, 'android-upload.jks'))
    const result = sync()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`Reusing ${join(signing, 'android-upload.jks')}.`)
    expect(readFileSync(join(signing, 'android-upload.jks'))).toEqual(before)
    expect(stored('ANDROID_UPLOAD_KEYSTORE')).toBe(before.toString('base64'))
    expect(stored('ANDROID_UPLOAD_KEYSTORE_PASSWORD')).toBe('existing-password')
  })

  // The values must reach the preflight and GitHub through the environment
  // and stdin, never a command line another process could read.
  it('never puts a stored value on a command line', () => {
    useExistingKey()
    expect(sync().status).toBe(0)
    for (const name of [
      'ANDROID_UPLOAD_KEYSTORE',
      'ANDROID_UPLOAD_KEYSTORE_PASSWORD',
      'PLAY_SERVICE_ACCOUNT_JSON',
    ]) {
      expect(ghLog()).not.toContain(stored(name))
    }
  })

  it('generates the key and runs the preflight, but writes nothing to GitHub, on a dry run', () => {
    const result = sync(['--dry-run'])
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(signing, 'android-upload.jks'))).toBe(true)
    expect(result.stdout).toContain('checks/android-play-preflight: OK')
    expect(result.stdout).toContain('Would set secret ANDROID_UPLOAD_KEYSTORE in android-play.')
    expect(existsSync(join(fake, 'github'))).toBe(false)
    expect(ghLog()).not.toMatch(/-X PUT|-X POST| set /)
  })

  it('reads the service account key from --service-account', () => {
    rmSync(join(signing, 'play-service-account.json'))
    const elsewhere = join(dir, 'key.json')
    const other = JSON.stringify({ ...JSON.parse(serviceAccount), client_email: 'other@x.iam' })
    writeFileSync(elsewhere, other)
    const result = sync(['--service-account', elsewhere])
    expect(result.status, result.stderr).toBe(0)
    expect(stored('PLAY_SERVICE_ACCOUNT_JSON')).toBe(other)
  })

  it('refuses to run without a service account key, before generating anything', () => {
    rmSync(join(signing, 'play-service-account.json'))
    const result = sync()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      `No service account key at ${join(signing, 'play-service-account.json')}.`
    )
    expect(existsSync(join(signing, 'android-upload.jks'))).toBe(false)
    expect(ghLog()).toBe('')
  })

  it('stores nothing when the preflight fails', () => {
    writeFileSync(join(signing, 'play-service-account.json'), '{"type":"authorized_user"}')
    const result = sync()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("PLAY_SERVICE_ACCOUNT_JSON has type 'authorized_user'")
    expect(result.stderr).toContain('Not stored')
    expect(existsSync(join(fake, 'github'))).toBe(false)
  })

  // Generating a fresh key here would orphan the one Play Console knows.
  it('refuses a keystore whose password file is missing', () => {
    useExistingKey()
    rmSync(join(signing, 'android-upload.password'))
    const result = sync()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('android-upload.password does not')
    expect(ghLog()).not.toContain(' set ')
  })

  it('refuses a password file that does not open the keystore', () => {
    useExistingKey()
    writeFileSync(join(signing, 'android-upload.password'), 'wrong-password')
    const result = sync()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Could not read the 'upload' certificate")
    expect(ghLog()).not.toContain(' set ')
  })

  it('refuses an unknown argument', () => {
    const result = sync(['--channel', 'android'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('android-signing-sync.sh [--dry-run]')
    expect(ghLog()).toBe('')
  })
})
