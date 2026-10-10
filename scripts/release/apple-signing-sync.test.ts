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

// The script talks to the world through curl (App Store Connect), gh
// (GitHub) and the preflights, so fakes for each go first on PATH:
//
// - curl plays App Store Connect from fixture files in FAKE_DIR, signing any
//   CSR it is sent with a test CA, and logs `<method> <path>` per request
//   along with the key id its token names.
// - gh logs each call's arguments, and for `secret set` / `variable set` the
//   value it read from stdin, into FAKE_DIR/github/<env>/<name>.
// - uname answers Darwin, except inside a preflight — recognised by the
//   channel inputs in its environment — where it records those inputs and
//   answers Linux, so the preflight skips (and passes) as it does on any
//   non-Mac.
const here = dirname(fileURLToPath(import.meta.url))
const scriptPath = join(here, 'apple-signing-sync.sh')
const bundleIdentifier = 'io.wildflowerhealth.hostapp'
const team = 'ABCDE12345'

const fakeCurl = `#!/usr/bin/env python3
import base64, json, os, subprocess, sys, tempfile
args = sys.argv[1:]
method, out, body, url, kid = 'GET', None, None, None, None
i = 0
while i < len(args):
    a = args[i]
    if a == '-X': method = args[i + 1]; i += 1
    elif a == '--output': out = args[i + 1]; i += 1
    elif a == '--data-binary': body = args[i + 1][1:]; i += 1
    elif a == '-H' and args[i + 1].startswith('@'):
        with open(args[i + 1][1:]) as header:
            token = header.read().split('Bearer ', 1)[1].strip()
        kid = json.loads(base64.urlsafe_b64decode(token.split('.')[0] + '=='))['kid']
        i += 1
    elif a in ('-H', '--write-out', '--max-time'): i += 1
    elif a.startswith('https://'): url = a
    i += 1
fake = os.environ['FAKE_DIR']
path = url.split('api.appstoreconnect.apple.com', 1)[1]
route = path.split('?', 1)[0]
with open(os.path.join(fake, 'curl.log'), 'a') as log:
    log.write(method + ' ' + path + '\\n')
    log.write('ARGV ' + ' '.join(args) + '\\n')
    log.write('KID ' + kid + '\\n')
status, response = 404, {'errors': [{'status': '404', 'code': 'NOT_FOUND', 'title': 'no route', 'detail': path}]}
def fixture(name):
    with open(os.path.join(fake, name)) as handle:
        return json.load(handle)
if method == 'GET' and route == '/v1/certificates':
    status, response = 200, fixture('certificates.json')
elif method == 'GET' and route == '/v1/bundleIds':
    status, response = 200, fixture('app-ids.json')
elif method == 'GET' and route == '/v1/profiles':
    status, response = 200, fixture('profiles.json')
elif method == 'DELETE' and route.startswith('/v1/profiles/'):
    status, response = 204, None
elif method == 'POST' and route == '/v1/certificates':
    request = json.load(open(body))['data']['attributes']
    kind = request['certificateType']
    refusal = os.environ.get('FAKE_REFUSE_' + kind)
    if refusal:
        status, response = int(refusal), {'errors': [{'status': refusal, 'code': 'ENTITY_ERROR', 'title': 'Refused', 'detail': 'You already have a current certificate.'}]}
    else:
        label = {'DISTRIBUTION': 'Apple Distribution', 'MAC_INSTALLER_DISTRIBUTION': '3rd Party Mac Developer Installer', 'DEVELOPER_ID_APPLICATION_G2': 'Developer ID Application'}[kind]
        with tempfile.NamedTemporaryFile('w', suffix='.csr', delete=False) as csr:
            csr.write(request['csrContent'])
        der = subprocess.run(['openssl', 'x509', '-req', '-in', csr.name, '-CA', os.path.join(fake, 'ca.pem'), '-CAkey', os.path.join(fake, 'ca.key'), '-subj', '/CN=%s: Wildflower (${team})/OU=${team}' % label, '-days', '365', '-outform', 'DER'], check=True, capture_output=True).stdout
        status, response = 201, {'data': {'type': 'certificates', 'id': 'new-' + kind, 'attributes': {'certificateType': kind, 'expirationDate': '2031-01-02T00:00:00.000+00:00', 'certificateContent': base64.b64encode(der).decode()}}}
elif method == 'POST' and route == '/v1/profiles':
    request = json.load(open(body))['data']
    kind = request['attributes']['profileType']
    with open(os.path.join(fake, 'created-profile-' + kind + '.json'), 'w') as handle:
        json.dump(request, handle)
    status, response = 201, {'data': {'type': 'profiles', 'id': 'new-' + kind, 'attributes': {'name': request['attributes']['name'], 'expirationDate': '2030-05-06T00:00:00.000+00:00', 'profileContent': base64.b64encode(('profile ' + kind).encode()).decode()}}}
with open(out, 'w') as handle:
    if response is not None:
        json.dump(response, handle)
sys.stdout.write(str(status))
`

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
    # GET of a missing environment fails; PUT creates it.
    [[ "$2" == -X ]] || [[ -n "\${FAKE_ENVIRONMENTS_EXIST:-}" ]] || exit 1
    ;;
esac
`

const fakeUname = `#!/usr/bin/env bash
if [[ -n "\${IOS_CERTIFICATE:-}\${MACOS_APPSTORE_CERTIFICATE:-}\${APPLE_CERTIFICATE:-}" ]]; then
  { env | grep -E '^(IOS_|MACOS_|APPLE_|BUNDLE_)' | sort; echo --END--; } >> "$FAKE_DIR/preflight.log"
  echo Linux
else
  echo Darwin
fi
`

let dir: string
let fake: string
let signing: string
let pool: string

const openssl = (...args: ReadonlyArray<string>): string =>
  execFileSync('openssl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

const kinds = ['distribution', 'mac-installer', 'developer-id'] as const

// RSA key generation dominates the run time, so the test CA and the signing
// folder's keys are made once and copied into each test's folders.
beforeAll(() => {
  pool = mkdtempSync(join(tmpdir(), 'apple-signing-sync-keys-'))
  openssl('genrsa', '-out', join(pool, 'ca.key'), '2048')
  openssl(
    'req',
    '-x509',
    '-new',
    '-key',
    join(pool, 'ca.key'),
    '-subj',
    '/CN=Test CA',
    '-days',
    '2',
    '-out',
    join(pool, 'ca.pem')
  )
  for (const kind of kinds) openssl('genrsa', '-out', join(pool, `${kind}.key.pem`), '2048')
})

afterAll(() => {
  rmSync(pool, { recursive: true, force: true })
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'apple-signing-sync-'))
  fake = join(dir, 'fake')
  signing = join(dir, 'signing')
  mkdirSync(join(dir, 'bin'))
  mkdirSync(fake)
  mkdirSync(signing)
  for (const [name, body] of [
    ['curl', fakeCurl],
    ['gh', fakeGh],
    ['uname', fakeUname],
  ] as const) {
    writeFileSync(join(dir, 'bin', name), body)
    chmodSync(join(dir, 'bin', name), 0o755)
  }
  copyFileSync(join(pool, 'ca.key'), join(fake, 'ca.key'))
  copyFileSync(join(pool, 'ca.pem'), join(fake, 'ca.pem'))
  for (const kind of kinds)
    copyFileSync(join(pool, `${kind}.key.pem`), join(signing, `${kind}.key.pem`))
  execFileSync('bash', [
    '-c',
    'openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -out "$0"',
    join(signing, 'AuthKey_ADMINKEY.p8'),
  ])
  writeFixtures({ certificates: [], profiles: [] })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const writeFixtures = (opts: {
  certificates?: ReadonlyArray<object>
  profiles?: ReadonlyArray<object>
  appIds?: ReadonlyArray<object>
}): void => {
  if (opts.certificates) {
    writeFileSync(join(fake, 'certificates.json'), JSON.stringify({ data: opts.certificates }))
  }
  if (opts.profiles) {
    writeFileSync(join(fake, 'profiles.json'), JSON.stringify({ data: opts.profiles }))
  }
  writeFileSync(
    join(fake, 'app-ids.json'),
    JSON.stringify({
      data: opts.appIds ?? [
        // filter[identifier] is a substring match; the decoy must be ignored.
        {
          type: 'bundleIds',
          id: 'decoy',
          attributes: { identifier: `${bundleIdentifier}.widget`, platform: 'UNIVERSAL' },
        },
        {
          type: 'bundleIds',
          id: 'app',
          attributes: { identifier: bundleIdentifier, platform: 'UNIVERSAL' },
        },
      ],
    })
  )
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
      APP_STORE_CONNECT_ISSUER_ID: 'issuer-uuid',
      ...env,
    },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const appleCalls = (): ReadonlyArray<string> =>
  existsSync(join(fake, 'curl.log'))
    ? readFileSync(join(fake, 'curl.log'), 'utf8')
        .split('\n')
        .filter((line) => line !== '' && !line.startsWith('ARGV ') && !line.startsWith('KID '))
    : []

const appleWrites = (): ReadonlyArray<string> =>
  appleCalls().filter((call) => !call.startsWith('GET '))

const stored = (environment: string, name: string): string =>
  readFileSync(join(fake, 'github', environment, name), 'utf8')

const storedNames = (environment: string): ReadonlyArray<string> => {
  const log = readFileSync(join(fake, 'gh.log'), 'utf8')
  return log
    .split('\n')
    .filter((line) => / set /.test(` ${line} `) && line.includes(`--env ${environment}`))
    .map((line) => line.split(' ')[2])
    .toSorted()
}

// The shape of a certificate or profile in an App Store Connect response.
interface AscResource {
  readonly type: string
  readonly id: string
  readonly attributes: Readonly<Record<string, string>>
  readonly relationships?: Readonly<Record<string, unknown>>
}

// A certificate made from the key the script keeps for this kind, as Apple
// would list it.
const listedCertificate = (
  kind: string,
  type: string,
  label: string,
  expires: string,
  id: string
): AscResource => {
  const key = join(signing, `${kind}.key.pem`)
  const csr = join(dir, `${id}.csr`)
  const der = join(dir, `${id}.der`)
  openssl('req', '-new', '-key', key, '-subj', '/CN=x', '-out', csr)
  openssl(
    'x509',
    '-req',
    '-in',
    csr,
    '-CA',
    join(fake, 'ca.pem'),
    '-CAkey',
    join(fake, 'ca.key'),
    '-subj',
    `/CN=${label}: Wildflower (${team})/OU=${team}`,
    '-days',
    '365',
    '-outform',
    'DER',
    '-out',
    der
  )
  return {
    type: 'certificates',
    id,
    attributes: {
      certificateType: type,
      name: label,
      expirationDate: expires,
      certificateContent: readFileSync(der).toString('base64'),
    },
  }
}

const allListed = (expires = '2031-01-01T00:00:00.000+00:00'): ReadonlyArray<AscResource> => [
  listedCertificate('distribution', 'DISTRIBUTION', 'Apple Distribution', expires, 'dist'),
  listedCertificate(
    'mac-installer',
    'MAC_INSTALLER_DISTRIBUTION',
    '3rd Party Mac Developer Installer',
    expires,
    'inst'
  ),
  listedCertificate(
    'developer-id',
    'DEVELOPER_ID_APPLICATION_G2',
    'Developer ID Application',
    expires,
    'devid'
  ),
]

const profile = (
  id: string,
  profileType: string,
  certificateId: string,
  opts: { name?: string; state?: string } = {}
): AscResource => ({
  type: 'profiles',
  id,
  attributes: {
    name: opts.name ?? `Wildflower ${bundleIdentifier} ${profileType}`,
    profileState: opts.state ?? 'ACTIVE',
    expirationDate: '2030-01-01T00:00:00.000+00:00',
    profileContent: Buffer.from(`listed ${id}`).toString('base64'),
  },
  relationships: {
    certificates: { data: [{ type: 'certificates', id: certificateId }] },
    bundleId: { data: { type: 'bundleIds', id: 'app' } },
  },
})

// Opens a stored .p12 with its stored password, as the runner's `security
// import` does, and returns the certificate subject and whether the key in it
// is the signing folder's.
const openP12 = (
  environment: string,
  name: string,
  kind: string
): { subject: string; ownKey: boolean } => {
  const p12 = join(dir, `${environment}-${name}.p12`)
  const password = join(dir, `${environment}-${name}.password`)
  writeFileSync(p12, Buffer.from(stored(environment, name), 'base64'))
  writeFileSync(password, stored(environment, `${name}_PASSWORD`))
  const pem = openssl('pkcs12', '-in', p12, '-passin', `file:${password}`, '-nodes', '-legacy')
  const pemPath = join(dir, `${environment}-${name}.pem`)
  writeFileSync(pemPath, pem)
  const subject = openssl('x509', '-in', pemPath, '-noout', '-subject')
  const keyOf = (path: string): string => openssl('pkey', '-in', path, '-pubout')
  return { subject, ownKey: keyOf(pemPath) === keyOf(join(signing, `${kind}.key.pem`)) }
}

// Each test runs the whole script against the fakes — dozens of processes —
// which outlasts the default timeout on a loaded runner.
describe('apple-signing-sync', { timeout: 30_000 }, () => {
  it('creates every credential on a first run and stores each channel in its environment', () => {
    for (const kind of kinds) rmSync(join(signing, `${kind}.key.pem`))
    const result = sync()
    expect(result.stdout).toContain(
      `Generated a new private key at ${join(signing, 'distribution.key.pem')}.`
    )
    expect(result.status, result.stderr).toBe(0)

    expect(appleWrites()).toEqual([
      'POST /v1/certificates',
      'POST /v1/profiles',
      'POST /v1/certificates',
      'POST /v1/profiles',
      'POST /v1/certificates',
    ])

    expect(storedNames('apple-ios')).toEqual([
      'IOS_CERTIFICATE',
      'IOS_CERTIFICATE_PASSWORD',
      'IOS_PROVISIONING_PROFILE',
    ])
    expect(storedNames('apple-macos-appstore')).toEqual([
      'MACOS_APPSTORE_CERTIFICATE',
      'MACOS_APPSTORE_CERTIFICATE_PASSWORD',
      'MACOS_APPSTORE_SIGNING_IDENTITY',
      'MACOS_INSTALLER_CERTIFICATE',
      'MACOS_INSTALLER_CERTIFICATE_PASSWORD',
      'MACOS_INSTALLER_SIGNING_IDENTITY',
      'MACOS_PROVISIONING_PROFILE',
    ])
    expect(storedNames('apple-macos-direct')).toEqual([
      'APPLE_CERTIFICATE',
      'APPLE_CERTIFICATE_PASSWORD',
      'APPLE_SIGNING_IDENTITY',
    ])

    // The .p12s open with their passwords and carry the persistent keys.
    const ios = openP12('apple-ios', 'IOS_CERTIFICATE', 'distribution')
    expect(ios.subject).toContain('Apple Distribution')
    expect(ios.ownKey).toBe(true)
    expect(
      openP12('apple-macos-appstore', 'MACOS_INSTALLER_CERTIFICATE', 'mac-installer').ownKey
    ).toBe(true)
    expect(openP12('apple-macos-direct', 'APPLE_CERTIFICATE', 'developer-id').ownKey).toBe(true)

    expect(stored('apple-macos-direct', 'APPLE_SIGNING_IDENTITY')).toBe(
      `Developer ID Application: Wildflower (${team})`
    )
    expect(Buffer.from(stored('apple-ios', 'IOS_PROVISIONING_PROFILE'), 'base64').toString()).toBe(
      'profile IOS_APP_STORE'
    )

    // Each profile is bound to the new certificate and the exact App ID.
    const created: unknown = JSON.parse(
      readFileSync(join(fake, 'created-profile-MAC_APP_STORE.json'), 'utf8')
    )
    expect(created).toHaveProperty('relationships', {
      bundleId: { data: { type: 'bundleIds', id: 'app' } },
      certificates: { data: [{ type: 'certificates', id: 'new-DISTRIBUTION' }] },
    })

    expect(readFileSync(join(fake, 'gh.log'), 'utf8')).toContain(
      'api -X PUT repos/{owner}/{repo}/environments/apple-ios --silent'
    )
  })

  // The values must reach the preflights and GitHub through the environment
  // and stdin, never a command line another process could read.
  it('never puts a stored value on a command line', () => {
    expect(sync().status).toBe(0)
    const commandLines =
      readFileSync(join(fake, 'gh.log'), 'utf8') + readFileSync(join(fake, 'curl.log'), 'utf8')
    for (const name of [
      'IOS_CERTIFICATE',
      'IOS_CERTIFICATE_PASSWORD',
      'APPLE_CERTIFICATE_PASSWORD',
    ]) {
      const value = stored(name.startsWith('IOS') ? 'apple-ios' : 'apple-macos-direct', name)
      expect(commandLines).not.toContain(value)
    }
  })

  it('hands each preflight the inputs CI gives it', () => {
    expect(sync().status).toBe(0)
    const runs = readFileSync(join(fake, 'preflight.log'), 'utf8')
      .split('--END--\n')
      .filter(Boolean)
    const ios = runs.find((run) => run.includes('IOS_CERTIFICATE='))!
    expect(ios).toContain(`APPLE_DEVELOPMENT_TEAM=${team}\n`)
    expect(ios).toContain(`BUNDLE_IDENTIFIER=${bundleIdentifier}\n`)
    expect(ios).toContain(
      `IOS_MOBILE_PROVISION=${stored('apple-ios', 'IOS_PROVISIONING_PROFILE')}\n`
    )
    const appstore = runs.find((run) => run.includes('MACOS_APPSTORE_CERTIFICATE='))!
    expect(appstore).toContain(`APPLE_TEAM_ID=${team}\n`)
    const direct = runs.find((run) => run.includes('APPLE_CERTIFICATE='))!
    expect(direct).toContain(
      `APPLE_SIGNING_IDENTITY=Developer ID Application: Wildflower (${team})\n`
    )
  })

  it('creates and deletes nothing when everything is current', () => {
    writeFixtures({
      certificates: allListed(),
      profiles: [
        profile('ios-profile', 'IOS_APP_STORE', 'dist'),
        profile('mac-profile', 'MAC_APP_STORE', 'dist'),
      ],
    })
    const result = sync([], { FAKE_ENVIRONMENTS_EXIST: '1' })
    expect(result.status, result.stderr).toBe(0)
    expect(appleWrites()).toEqual([])
    expect(Buffer.from(stored('apple-ios', 'IOS_PROVISIONING_PROFILE'), 'base64').toString()).toBe(
      'listed ios-profile'
    )
    expect(readFileSync(join(fake, 'gh.log'), 'utf8')).not.toContain('-X PUT')
    expect(result.stdout).toMatch(
      /ios\s+Apple Distribution\s+dist\s+2031-01-01\s+2030-01-01\s+certificate reused, profile reused, stored/
    )
  })

  // A renewed certificate leaves the old profile bound to the old one. Only
  // the profile with exactly our name is replaced; a hand-made profile
  // carrying a similar name is never touched.
  it('replaces only its own profile when it no longer lists the certificate', () => {
    writeFixtures({
      certificates: allListed(),
      profiles: [
        profile('stale', 'IOS_APP_STORE', 'retired'),
        profile('hand-made', 'IOS_APP_STORE', 'retired', {
          name: `Wildflower ${bundleIdentifier} IOS_APP_STORE (manual)`,
        }),
      ],
    })
    expect(sync(['--channel', 'ios']).status).toBe(0)
    expect(appleWrites()).toEqual(['DELETE /v1/profiles/stale', 'POST /v1/profiles'])
  })

  it('renews a certificate inside the renewal window, from the same key', () => {
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString()
    writeFixtures({ certificates: allListed(soon) })
    const keyBefore = readFileSync(join(signing, 'developer-id.key.pem'), 'utf8')
    expect(sync(['--channel', 'macos-direct']).status).toBe(0)
    expect(appleWrites()).toEqual(['POST /v1/certificates'])
    expect(readFileSync(join(signing, 'developer-id.key.pem'), 'utf8')).toBe(keyBefore)
  })

  it('writes nothing anywhere on a dry run, and says what it would have', () => {
    const result = sync(['--dry-run'])
    expect(result.status, result.stderr).toBe(0)
    expect(appleWrites()).toEqual([])
    expect(existsSync(join(fake, 'github'))).toBe(false)
    expect(readFileSync(join(fake, 'gh.log'), 'utf8')).not.toMatch(/-X PUT| set /)
    expect(result.stdout).toContain('Would create a DISTRIBUTION certificate')
    expect(result.stdout).toContain('not stored: dry run, would create')
  })

  it('checks and reports, but does not store, current credentials on a dry run', () => {
    writeFixtures({ certificates: allListed() })
    const result = sync(['--dry-run', '--channel', 'macos-direct'])
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(join(fake, 'preflight.log'), 'utf8')).toContain('APPLE_CERTIFICATE=')
    expect(result.stdout).toContain('Would set secret APPLE_CERTIFICATE in apple-macos-direct.')
    expect(existsSync(join(fake, 'github'))).toBe(false)
  })

  it('syncs only the channels asked for', () => {
    expect(sync(['--channel', 'macos-direct']).status).toBe(0)
    expect(existsSync(join(fake, 'github', 'apple-ios'))).toBe(false)
    expect(existsSync(join(fake, 'github', 'apple-macos-direct'))).toBe(true)
  })

  // Nothing is ever revoked: at the cap, the existing certificates are
  // listed for revoking by hand.
  it('lists the existing certificates when Apple refuses a new one, and revokes none', () => {
    writeFixtures({
      certificates: [
        {
          type: 'certificates',
          id: 'someone-elses',
          attributes: {
            certificateType: 'DISTRIBUTION',
            name: 'Apple Distribution: Other',
            expirationDate: '2030-02-03T00:00:00.000+00:00',
            certificateContent: '',
          },
        },
      ],
    })
    const result = sync(['--channel', 'ios'], { FAKE_REFUSE_DISTRIBUTION: '409' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      'someone-elses  DISTRIBUTION  Apple Distribution: Other  expires 2030-02-03'
    )
    expect(result.stderr).toContain('You already have a current certificate.')
    expect(appleWrites()).toEqual(['POST /v1/certificates'])
  })

  it('asks for a portal-made Developer ID certificate when the API will not make one', () => {
    const result = sync(['--channel', 'macos-direct'], {
      FAKE_REFUSE_DEVELOPER_ID_APPLICATION_G2: '403',
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`Upload ${join(signing, 'developer-id.csr.pem')}`)
    expect(result.stderr).toContain(`Re-run once ${join(signing, 'developer-id.cer')} is in place.`)
  })

  it('uses a portal-made Developer ID certificate saved in the signing folder', () => {
    const [, , devid] = allListed()
    writeFileSync(
      join(signing, 'developer-id.cer'),
      Buffer.from(devid.attributes.certificateContent, 'base64')
    )
    const result = sync(['--channel', 'macos-direct'])
    expect(result.status, result.stderr).toBe(0)
    expect(appleWrites()).toEqual([])
    expect(openP12('apple-macos-direct', 'APPLE_CERTIFICATE', 'developer-id').ownKey).toBe(true)
  })

  it('refuses an App ID that cannot carry a Mac App Store profile', () => {
    writeFixtures({
      appIds: [
        {
          type: 'bundleIds',
          id: 'app',
          attributes: { identifier: bundleIdentifier, platform: 'IOS' },
        },
      ],
    })
    const result = sync(['--channel', 'macos-appstore'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`App ID '${bundleIdentifier}' is registered for IOS`)
    expect(appleWrites()).not.toContain('POST /v1/profiles')
  })

  it('refuses an unknown channel before doing anything', () => {
    const result = sync(['--channel', 'android'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Unknown channel 'android'")
    expect(appleCalls()).toEqual([])
  })

  it('names the key in the signing folder by its file name', () => {
    expect(sync(['--channel', 'macos-direct']).status).toBe(0)
    const kids = readFileSync(join(fake, 'curl.log'), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('KID '))
    expect(kids.length).toBeGreaterThan(0)
    expect(new Set(kids)).toEqual(new Set(['KID ADMINKEY']))
  })

  it('names a key given by path by its file name', () => {
    const elsewhere = join(dir, 'AuthKey_ELSEWHERE.p8')
    copyFileSync(join(signing, 'AuthKey_ADMINKEY.p8'), elsewhere)
    rmSync(join(signing, 'AuthKey_ADMINKEY.p8'))
    expect(
      sync(['--channel', 'macos-direct'], { APP_STORE_CONNECT_ADMIN_KEY_PATH: elsewhere }).status
    ).toBe(0)
    expect(readFileSync(join(fake, 'curl.log'), 'utf8')).toContain('KID ELSEWHERE\n')
  })

  it('refuses a signing folder with no key', () => {
    rmSync(join(signing, 'AuthKey_ADMINKEY.p8'))
    const result = sync()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`No AuthKey_<key id>.p8 in ${signing}.`)
    expect(appleCalls()).toEqual([])
  })

  // Picking one would be a guess at which key is current.
  it('refuses a signing folder with more than one key', () => {
    copyFileSync(join(signing, 'AuthKey_ADMINKEY.p8'), join(signing, 'AuthKey_OLDKEY.p8'))
    const result = sync()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('AuthKey_ADMINKEY.p8 AuthKey_OLDKEY.p8')
    expect(appleCalls()).toEqual([])
  })

  it('refuses a key given by path whose name carries no key id', () => {
    const renamed = join(dir, 'admin.p8')
    copyFileSync(join(signing, 'AuthKey_ADMINKEY.p8'), renamed)
    const result = sync([], { APP_STORE_CONNECT_ADMIN_KEY_PATH: renamed })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`${renamed} is not named AuthKey_<key id>.p8`)
    expect(appleCalls()).toEqual([])
  })

  it('refuses to run off macOS', () => {
    writeFileSync(join(dir, 'bin', 'uname'), '#!/usr/bin/env bash\necho Linux\n')
    const result = sync()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('needs macOS')
  })
})
