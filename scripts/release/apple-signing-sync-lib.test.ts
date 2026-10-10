import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

// The parts of apple-signing-sync.sh that need no Mac. Sourcing the library
// defines them with no I/O, so they run anywhere openssl and python3 do.
const libPath = join(dirname(fileURLToPath(import.meta.url)), 'apple-signing-sync-lib.sh')

const callHelper = (fn: string, ...args: ReadonlyArray<string>): string =>
  execFileSync('bash', ['-c', `source "$0"; ${fn} "\${@:2}"`, libPath, '--', ...args], {
    encoding: 'utf8',
  }).trim()

// A helper's exit code alongside its output, for the ones whose refusal is
// the interesting case.
const tryHelper = (fn: string, ...args: ReadonlyArray<string>): { out: string; code: number } => {
  const result = spawnSync('bash', ['-c', `source "$0"; ${fn} "\${@:2}"`, libPath, '--', ...args], {
    encoding: 'utf8',
  })
  return { out: result.stdout.trim(), code: result.status ?? -1 }
}

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'apple-signing-sync-lib-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const writeJson = (name: string, value: unknown): string => {
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify(value))
  return path
}

describe('channel_environment', () => {
  it.each([
    ['ios', 'apple-ios'],
    ['macos-appstore', 'apple-macos-appstore'],
    ['macos-direct', 'apple-macos-direct'],
  ])('stores %s in %s', (channel, environment) => {
    expect(callHelper('channel_environment', channel)).toBe(environment)
  })

  // `--channel` is validated with this, so a typo has to be a refusal rather
  // than an environment named after it.
  it('refuses a channel that does not exist', () => {
    expect(tryHelper('channel_environment', 'macos').code).toBe(1)
  })
})

describe('certificate_list_types', () => {
  // The portal only makes G2 Developer ID certificates now, but older ones
  // list under the plain type; both are ours if the key matches.
  it('lists both Developer ID spellings', () => {
    expect(callHelper('certificate_list_types', 'developer-id')).toBe(
      'DEVELOPER_ID_APPLICATION,DEVELOPER_ID_APPLICATION_G2'
    )
  })

  it('lists the created type for the others', () => {
    expect(callHelper('certificate_list_types', 'distribution')).toBe('DISTRIBUTION')
    expect(callHelper('certificate_list_types', 'mac-installer')).toBe('MAC_INSTALLER_DISTRIBUTION')
  })
})

const DAY = 86_400
const NOW = 1_800_000_000

describe('certificate_verdict', () => {
  it('reuses our certificate with time to spare', () => {
    expect(
      callHelper('certificate_verdict', 'true', String(NOW + 31 * DAY), String(NOW), '30')
    ).toBe('reuse')
  })

  // The renewal window is inclusive: a certificate expiring exactly at its
  // edge is renewed now rather than left to lapse mid-release.
  it('renews at the edge of the window', () => {
    expect(
      callHelper('certificate_verdict', 'true', String(NOW + 30 * DAY), String(NOW), '30')
    ).toBe('expiring')
  })

  // However long it has left, a certificate made from another key cannot be
  // exported: its private key is not in the signing folder.
  it('never reuses a certificate made from another key', () => {
    expect(
      callHelper('certificate_verdict', 'false', String(NOW + 365 * DAY), String(NOW), '30')
    ).toBe('other-key')
  })
})

describe('profile_verdict', () => {
  const fresh = String(NOW + 200 * DAY)
  it.each([
    [['ACTIVE', 'true', 'true', fresh], 'reuse'],
    [['INVALID', 'true', 'true', fresh], 'inactive'],
    // The usual case after a certificate renewal.
    [['ACTIVE', 'false', 'true', fresh], 'other-certificate'],
    [['ACTIVE', 'true', 'false', fresh], 'other-app-id'],
    [['ACTIVE', 'true', 'true', String(NOW + 10 * DAY)], 'expiring'],
  ])('%j is %s', (args, expected) => {
    expect(callHelper('profile_verdict', ...args, String(NOW), '30')).toBe(expected)
  })
})

describe('profile_name', () => {
  it('names the profile after the bundle id and type', () => {
    expect(callHelper('profile_name', 'io.wildflowerhealth.hostapp', 'MAC_APP_STORE')).toBe(
      'Wildflower io.wildflowerhealth.hostapp MAC_APP_STORE'
    )
  })
})

describe('common_name_from_subject', () => {
  // The organisation name has a comma in it, which is why the subject is read
  // one attribute per line rather than split on commas.
  it('reads the common name from multiline subject output', () => {
    const subject = [
      'subject=',
      '    userId                    = ABCDE12345',
      '    commonName                = Apple Distribution: Wildflower Health, Inc. (ABCDE12345)',
      '    organizationalUnitName    = ABCDE12345',
      '    organizationName          = Wildflower Health, Inc.',
    ].join('\n')
    expect(callHelper('common_name_from_subject', subject)).toBe(
      'Apple Distribution: Wildflower Health, Inc. (ABCDE12345)'
    )
  })
})

describe('team_id_from_common_name', () => {
  it('reads the trailing team id', () => {
    expect(
      callHelper('team_id_from_common_name', 'Developer ID Application: Wildflower (29QHKJX9V7)')
    ).toBe('29QHKJX9V7')
  })

  it('refuses a name without one', () => {
    expect(tryHelper('team_id_from_common_name', 'Wildflower distribution').code).toBe(1)
  })
})

describe('asc_key_id_from_path', () => {
  it('reads the key id from the name App Store Connect downloads it with', () => {
    expect(
      callHelper('asc_key_id_from_path', '/Users/me/.wildflower-signing/AuthKey_8BXMC4XDDP.p8')
    ).toBe('8BXMC4XDDP')
  })

  // The folder may itself look like a key; only the file name counts.
  it('reads only the file name', () => {
    expect(callHelper('asc_key_id_from_path', '/keys/AuthKey_FOLDER.p8/AuthKey_ABC123.p8')).toBe(
      'ABC123'
    )
  })

  it.each([
    '/keys/admin.p8',
    '/keys/AuthKey_.p8',
    '/keys/AuthKey_ABC123.p8.bak',
    '/keys/AuthKey_A B.p8',
  ])('refuses %s', (path) => {
    expect(tryHelper('asc_key_id_from_path', path).code).toBe(1)
  })
})

// DER INTEGER encoding of an unsigned big-endian value, the way openssl writes
// r and s: leading zero bytes dropped, and a 00 prepended when the top bit is
// set so the value does not read as negative.
const derInteger = (value: Buffer): Buffer => {
  let start = 0
  while (start < value.length - 1 && value[start] === 0) start += 1
  let body = value.subarray(start)
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body])
  return Buffer.concat([Buffer.from([0x02, body.length]), body])
}

const derSignature = (r: Buffer, s: Buffer): Buffer => {
  const body = Buffer.concat([derInteger(r), derInteger(s)])
  return Buffer.concat([Buffer.from([0x30, body.length]), body])
}

describe('der_signature_to_raw', () => {
  const half = (byte: number): Buffer => Buffer.alloc(32, byte)

  // A high top bit gains a 00 in DER that must not reach the token: left in,
  // r is 33 bytes and Apple rejects the signature.
  it('drops the sign byte of a half with its top bit set', () => {
    const r = half(0x80)
    const s = half(0x01)
    expect(callHelper('der_signature_to_raw', derSignature(r, s).toString('hex'))).toBe(
      r.toString('hex') + s.toString('hex')
    )
  })

  // A half with leading zero bytes is shorter in DER and has to be padded
  // back to 32, or s slides into r's place.
  it('pads a short half back to 32 bytes', () => {
    const r = Buffer.concat([Buffer.alloc(2), half(0x11).subarray(2)])
    const s = half(0x7f)
    expect(callHelper('der_signature_to_raw', derSignature(r, s).toString('hex'))).toBe(
      r.toString('hex') + s.toString('hex')
    )
  })

  it.each([
    ['not hex', 'zz'],
    ['not a sequence', '0206010203'],
    ['a truncated integer', '3006022001020304'],
  ])('refuses %s', (_label, input) => {
    expect(tryHelper('der_signature_to_raw', input).code).toBe(1)
  })

  it('recovers r||s from any DER signature', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        (r, s) => {
          const der = derSignature(Buffer.from(r), Buffer.from(s)).toString('hex')
          expect(callHelper('der_signature_to_raw', der)).toBe(
            Buffer.from(r).toString('hex') + Buffer.from(s).toString('hex')
          )
        }
      ),
      // Each run spawns a bash process, so this buys breadth more cheaply at
      // a lower count than the repo-wide default.
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

const fromBase64url = (text: string): Buffer => Buffer.from(text, 'base64url')

describe('asc_jwt', () => {
  // Signs with a freshly generated P-256 key, as App Store Connect's .p8 is,
  // then verifies the token with openssl against the public half — so a token
  // Apple would reject fails here.
  const makeKey = (): { p8: string; pub: string } => {
    const p8 = join(dir, `key-${Math.random().toString(36).slice(2)}.p8`)
    const pub = `${p8}.pub`
    execFileSync('bash', [
      '-c',
      'openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -out "$0" && openssl pkey -in "$0" -pubout -out "$1"',
      p8,
      pub,
    ])
    return { p8, pub }
  }

  const verify = (token: string, pub: string): boolean => {
    const [header, payload, signature] = token.split('.')
    const raw = fromBase64url(signature)
    const data = join(dir, 'signing-input')
    const sig = join(dir, 'signature.der')
    writeFileSync(data, `${header}.${payload}`)
    writeFileSync(sig, derSignature(raw.subarray(0, 32), raw.subarray(32)))
    const result = spawnSync('openssl', [
      'dgst',
      '-sha256',
      '-verify',
      pub,
      '-signature',
      sig,
      data,
    ])
    return result.status === 0
  }

  it('carries the claims App Store Connect requires', () => {
    const { p8 } = makeKey()
    const [header, payload] = callHelper(
      'asc_jwt',
      'KEY1234567',
      'issuer-uuid',
      p8,
      '1700000000'
    ).split('.')
    expect(JSON.parse(fromBase64url(header).toString())).toEqual({
      alg: 'ES256',
      kid: 'KEY1234567',
      typ: 'JWT',
    })
    expect(JSON.parse(fromBase64url(payload).toString())).toEqual({
      iss: 'issuer-uuid',
      iat: 1_700_000_000,
      // Apple refuses a token that lives longer than 20 minutes.
      exp: 1_700_000_000 + 19 * 60,
      aud: 'appstoreconnect-v1',
    })
  })

  // Several tokens, because a conversion bug in one half shows up only when
  // that half happens to be short or high-bit — about one signature in two.
  it('is signed by the key, as raw r||s', () => {
    const { p8, pub } = makeKey()
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = callHelper('asc_jwt', 'KEY', 'issuer', p8, String(1_700_000_000 + attempt))
      expect(fromBase64url(token.split('.')[2]).length).toBe(64)
      expect(verify(token, pub)).toBe(true)
    }
  })

  it('does not verify against another key', () => {
    const { p8 } = makeKey()
    const other = makeKey()
    expect(verify(callHelper('asc_jwt', 'KEY', 'issuer', p8, '1700000000'), other.pub)).toBe(false)
  })
})

describe('public_key_digest', () => {
  const certify = (key: string, out: string): void => {
    execFileSync('openssl', [
      'req',
      '-x509',
      '-new',
      '-key',
      key,
      '-subj',
      '/CN=test',
      '-days',
      '1',
      '-outform',
      'DER',
      '-out',
      out,
    ])
  }

  // This is the whole of how a listed certificate is paired with the key in
  // the signing folder, so it must agree across the two encodings.
  it('pairs a certificate with the key it was issued for, and only that one', () => {
    const key = join(dir, 'rsa.pem')
    const otherKey = join(dir, 'rsa-other.pem')
    execFileSync('openssl', ['genrsa', '-out', key, '2048'], { stdio: 'ignore' })
    execFileSync('openssl', ['genrsa', '-out', otherKey, '2048'], { stdio: 'ignore' })
    const cert = join(dir, 'rsa.der')
    certify(key, cert)
    const keyDigest = callHelper('public_key_digest', 'key', key)
    expect(keyDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(callHelper('public_key_digest', 'certificate', cert)).toBe(keyDigest)
    expect(callHelper('public_key_digest', 'key', otherKey)).not.toBe(keyDigest)
  })
})

describe('asc_json', () => {
  const certificate = (id: string, type: string, expires: string): object => ({
    type: 'certificates',
    id,
    attributes: {
      certificateType: type,
      name: `${type} ${id}`,
      expirationDate: expires,
      certificateContent: `content-${id}`,
    },
  })

  it('lists certificates of the wanted types, longest-lived first', () => {
    const response = writeJson('certificates.json', {
      data: [
        certificate('short', 'DISTRIBUTION', '2027-01-01T00:00:00.000+00:00'),
        certificate('dev', 'DEVELOPMENT', '2030-01-01T00:00:00.000+00:00'),
        // Some responses end in Z, which python 3.9's fromisoformat rejects.
        certificate('long', 'DISTRIBUTION', '2028-06-30T12:00:00Z'),
      ],
    })
    const rows = callHelper('asc_json', 'certificates', response, 'DISTRIBUTION')
      .split('\n')
      .map((line) => line.split('\t'))
    expect(rows).toEqual([
      [
        'long',
        'DISTRIBUTION',
        String(Date.UTC(2028, 5, 30, 12) / 1000),
        '2028-06-30',
        'DISTRIBUTION long',
        'content-long',
      ],
      [
        'short',
        'DISTRIBUTION',
        String(Date.UTC(2027, 0, 1) / 1000),
        '2027-01-01',
        'DISTRIBUTION short',
        'content-short',
      ],
    ])
  })

  describe('app-id', () => {
    const appId = (id: string, identifier: string, platform: string): object => ({
      type: 'bundleIds',
      id,
      attributes: { identifier, platform },
    })

    // filter[identifier] is a substring match, so Apple's answer for the
    // app's identifier also carries every identifier that extends it.
    it('ignores identifiers that merely contain the one asked for', () => {
      const response = writeJson('app-ids.json', {
        data: [
          appId('widget', 'io.wildflowerhealth.hostapp.widget', 'IOS'),
          appId('app', 'io.wildflowerhealth.hostapp', 'UNIVERSAL'),
        ],
      })
      expect(
        callHelper(
          'asc_json',
          'app-id',
          response,
          'io.wildflowerhealth.hostapp',
          'MAC_OS,UNIVERSAL'
        )
      ).toBe('found app')
    })

    it('names the platform an unusable App ID is registered for', () => {
      const response = writeJson('app-ids-ios.json', {
        data: [appId('app', 'io.wildflowerhealth.hostapp', 'IOS')],
      })
      expect(
        callHelper(
          'asc_json',
          'app-id',
          response,
          'io.wildflowerhealth.hostapp',
          'MAC_OS,UNIVERSAL'
        )
      ).toBe('wrong-platform IOS')
    })

    it('reports an App ID only extended by others as missing', () => {
      const response = writeJson('app-ids-decoy.json', {
        data: [appId('widget', 'io.wildflowerhealth.hostapp.widget', 'IOS')],
      })
      expect(
        callHelper('asc_json', 'app-id', response, 'io.wildflowerhealth.hostapp', 'IOS,UNIVERSAL')
      ).toBe('missing')
    })
  })

  it('lists only profiles with exactly our name, with what they are bound to', () => {
    const profile = (id: string, name: string): object => ({
      type: 'profiles',
      id,
      attributes: {
        name,
        profileState: 'ACTIVE',
        expirationDate: '2027-03-04T00:00:00.000+00:00',
        profileContent: `content-${id}`,
      },
      relationships: {
        certificates: {
          data: [
            { type: 'certificates', id: 'c1' },
            { type: 'certificates', id: 'c2' },
          ],
        },
        bundleId: { data: { type: 'bundleIds', id: 'app' } },
      },
    })
    const name = 'Wildflower io.wildflowerhealth.hostapp IOS_APP_STORE'
    const response = writeJson('profiles.json', {
      data: [profile('ours', name), profile('hand-made', `${name} (manual)`)],
    })
    expect(callHelper('asc_json', 'profiles', response, name).split('\t')).toEqual([
      'ours',
      'ACTIVE',
      String(Date.UTC(2027, 2, 4) / 1000),
      '2027-03-04',
      'c1,c2',
      'app',
    ])
    expect(callHelper('asc_json', 'profile-content', response, 'ours')).toBe('content-ours')
  })

  it('reads Apple errors one per line', () => {
    const response = writeJson('errors.json', {
      errors: [{ status: '409', code: 'ENTITY_ERROR', title: 'Conflict', detail: 'At the cap.' }],
    })
    expect(callHelper('asc_json', 'errors', response)).toBe(
      '409 ENTITY_ERROR: Conflict — At the cap.'
    )
  })

  // An HTML error page or an empty body must not turn into a python
  // traceback in place of the HTTP status the caller is reporting.
  it('reads a body that is not JSON as no errors', () => {
    const response = join(dir, 'not-json')
    writeFileSync(response, '<html>Bad gateway</html>')
    expect(tryHelper('asc_json', 'errors', response)).toEqual({ out: '', code: 0 })
  })

  it('builds the certificate and profile request bodies', () => {
    const csr = join(dir, 'request.csr')
    writeFileSync(
      csr,
      '-----BEGIN CERTIFICATE REQUEST-----\nabc\n-----END CERTIFICATE REQUEST-----\n'
    )
    expect(JSON.parse(callHelper('asc_json', 'certificate-request', 'DISTRIBUTION', csr))).toEqual({
      data: {
        type: 'certificates',
        attributes: { certificateType: 'DISTRIBUTION', csrContent: readFileSync(csr, 'utf8') },
      },
    })
    expect(
      JSON.parse(
        callHelper(
          'asc_json',
          'profile-request',
          'Wildflower x MAC_APP_STORE',
          'MAC_APP_STORE',
          'app',
          'cert'
        )
      )
    ).toEqual({
      data: {
        type: 'profiles',
        attributes: { name: 'Wildflower x MAC_APP_STORE', profileType: 'MAC_APP_STORE' },
        relationships: {
          bundleId: { data: { type: 'bundleIds', id: 'app' } },
          certificates: { data: [{ type: 'certificates', id: 'cert' }] },
        },
      },
    })
  })

  // Profile names have spaces, and an unencoded one truncates the query.
  it('URL-encodes a query value', () => {
    expect(callHelper('asc_json', 'query', 'Wildflower a.b IOS_APP_STORE')).toBe(
      'Wildflower%20a.b%20IOS_APP_STORE'
    )
  })
})
