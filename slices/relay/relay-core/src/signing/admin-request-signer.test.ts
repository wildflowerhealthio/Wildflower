import { createHash, createHmac } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { importAdminKey } from '../key-store/index.ts'
import { signAdminRequest } from './admin-request-signer.ts'

/**
 * The request the relay's verifier checks too: `apps/relay/server`'s
 * `admin_request_fixture_from_the_js_signer_verifies` test reads this file and
 * verifies it at `created`. `UPDATE_FIXTURES=1 vp test` rewrites `headers`
 * from the signer.
 */
const FIXTURE_URL = new URL('./fixtures/admin-request.json', import.meta.url)

const AdminRequestFixture = Schema.Struct({
  key: Schema.String,
  created: Schema.Int,
  nonce: Schema.String,
  method: Schema.String,
  url: Schema.String,
  body: Schema.String,
  headers: Schema.Record({ key: Schema.String, value: Schema.String }),
})

const readFixture = (): typeof AdminRequestFixture.Type =>
  Schema.decodeUnknownSync(Schema.parseJson(AdminRequestFixture))(readFileSync(FIXTURE_URL, 'utf8'))

const encoder = new TextEncoder()

const ADMIN_KEY = 'an-admin-key-of-thirty-two-bytes'

/** `body`'s SHA-256 by Node's own hash, independent of the signer's Web Crypto. */
const sha256Base64 = (body: string): string => createHash('sha256').update(body).digest('base64')

/** The MAC the relay computes over `base` with `key`, as `sig=:<base64>:`. */
const expectedSignature = (key: string, base: string): string =>
  `sig=:${createHmac('sha256', key).update(base).digest('base64')}:`

describe('signAdminRequest', () => {
  it('signs the shared fixture request exactly as committed', async () => {
    // Arrange
    const fixture = readFixture()
    const key = await Effect.runPromise(importAdminKey(fixture.key))

    // Act
    const signed = await Effect.runPromise(
      signAdminRequest(
        key,
        { method: fixture.method, url: new URL(fixture.url), body: encoder.encode(fixture.body) },
        { created: fixture.created, nonce: fixture.nonce }
      )
    )
    const headers = { 'content-type': 'application/json', ...signed }
    if (process.env['UPDATE_FIXTURES'] === '1') {
      writeFileSync(FIXTURE_URL, `${JSON.stringify({ ...fixture, headers }, null, 2)}\n`)
    }

    // Assert
    expect(headers).toEqual(readFixture().headers)
  })

  it('covers the method, target URI and body digest, and MACs the base the relay rebuilds', async () => {
    // Arrange
    const body = '{"email":"bob@example.com"}'
    const key = await Effect.runPromise(importAdminKey(ADMIN_KEY))

    // Act
    const signed = await Effect.runPromise(
      signAdminRequest(
        key,
        {
          method: 'POST',
          url: new URL('https://ADMIN.relay.example.com:443/api/tunnels'),
          body: encoder.encode(body),
        },
        { created: 1_700_000_000, nonce: 'n-1' }
      )
    )

    // Assert
    const digest = `sha-256=:${sha256Base64(body)}:`
    const params =
      '("@method" "@target-uri" "content-digest");created=1700000000;nonce="n-1";keyid="admin";alg="hmac-sha256"'
    expect(signed).toEqual({
      'content-digest': digest,
      'signature-input': `sig=${params}`,
      signature: expectedSignature(
        ADMIN_KEY,
        [
          '"@method": POST',
          '"@target-uri": https://admin.relay.example.com/api/tunnels',
          `"content-digest": ${digest}`,
          `"@signature-params": ${params}`,
        ].join('\n')
      ),
    })
  })

  it('covers no digest for a request without a body', async () => {
    // Arrange
    const key = await Effect.runPromise(importAdminKey(ADMIN_KEY))

    // Act
    const signed = await Effect.runPromise(
      signAdminRequest(
        key,
        {
          method: 'DELETE',
          url: new URL('https://admin.relay.example.com/api/tunnels/bob'),
          body: new Uint8Array(),
        },
        { created: 1_700_000_001, nonce: 'n-2' }
      )
    )

    // Assert
    const params =
      '("@method" "@target-uri");created=1700000001;nonce="n-2";keyid="admin";alg="hmac-sha256"'
    expect(signed).toEqual({
      'signature-input': `sig=${params}`,
      signature: expectedSignature(
        ADMIN_KEY,
        [
          '"@method": DELETE',
          '"@target-uri": https://admin.relay.example.com/api/tunnels/bob',
          `"@signature-params": ${params}`,
        ].join('\n')
      ),
    })
  })
})
