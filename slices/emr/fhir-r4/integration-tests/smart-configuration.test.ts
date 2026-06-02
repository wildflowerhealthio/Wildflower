import { Effect, Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { SmartConfigurationSchema } from '../src/http-api-definition/smart-configuration.ts'
import { ORIGIN, wireServerScoped } from './server-helpers.ts'

const decodeConfig = Schema.decodeUnknownPromise(SmartConfigurationSchema)

const fetchSmartConfig = async (
  handler: (req: Request) => Promise<Response>,
  headers: Record<string, string>
): Promise<typeof SmartConfigurationSchema.Type> => {
  // `host` is a fetch-forbidden header name; passing it via
  // `new Request({ headers })` may drop it in strict runtimes. Building
  // a `Headers` object and `set`-ing each entry works because Node's
  // undici implementation doesn't enforce the spec's forbidden-name list
  // — not a documented escape hatch. Pin the header round-trips so a
  // future Node upgrade that tightens enforcement fails loudly here.
  const built = new Headers()
  for (const [name, value] of Object.entries(headers)) built.set(name, value)
  for (const [name, value] of Object.entries(headers)) expect(built.get(name)).toBe(value)
  const response = await handler(
    new Request(`${ORIGIN}/fhir-r4/.well-known/smart-configuration`, { headers: built })
  )
  expect(response.status).toBe(200)
  return decodeConfig(await response.json())
}

describe('GET /fhir-r4/.well-known/smart-configuration', () => {
  test('serves a SMART config that decodes against SmartConfigurationSchema', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wired = yield* wireServerScoped
          // The typed client decodes the response body against
          // `SmartConfigurationSchema`, so a successful return value already
          // proves required fields are present and parseable. We additionally
          // pin a few values to catch silent regressions in
          // `SmartConfigurationSchema.make`.
          const config = yield* wired.public['smart-well-known'].SmartConfiguration()

          expect(config.issuer).toBe(`${ORIGIN}/fhir-r4`)
          expect(config.token_endpoint).toBe(`${ORIGIN}/auth/token`)
          expect(config.authorization_endpoint).toBe(`${ORIGIN}/auth/authorize`)
          expect(config.grant_types_supported).toContain('authorization_code')
          expect(config.code_challenge_methods_supported).toContain('S256')
          expect(config.capabilities).toContain('launch-ehr')
        })
      )
    ))

  test('embeds the loopback Host in URLs when the request comes in via 127.0.0.1', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wired = yield* wireServerScoped
          const body = yield* Effect.promise(() =>
            fetchSmartConfig(wired.handler, { host: '127.0.0.1:3000' })
          )
          expect(body.issuer).toBe('http://127.0.0.1:3000/fhir-r4')
          expect(body.authorization_endpoint).toBe('http://127.0.0.1:3000/auth/authorize')
          expect(body.jwks_uri).toBe('http://127.0.0.1:3000/.well-known/jwks.json')
        })
      )
    ))

  test('embeds the forwarded host when the tunnel proxies a loopback request', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wired = yield* wireServerScoped
          const body = yield* Effect.promise(() =>
            fetchSmartConfig(wired.handler, {
              host: '127.0.0.1:3000',
              'x-forwarded-host': 'wildflower-node-dev.loca.lt',
              'x-forwarded-proto': 'https',
            })
          )
          expect(body.issuer).toBe('https://wildflower-node-dev.loca.lt/fhir-r4')
          expect(body.authorization_endpoint).toBe(
            'https://wildflower-node-dev.loca.lt/auth/authorize'
          )
          expect(body.jwks_uri).toBe('https://wildflower-node-dev.loca.lt/.well-known/jwks.json')
        })
      )
    ))

  test('ignores a half-forwarded pair (loopback host + only x-forwarded-host) and echoes loopback', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wired = yield* wireServerScoped
          const body = yield* Effect.promise(() =>
            fetchSmartConfig(wired.handler, {
              host: '127.0.0.1:3000',
              'x-forwarded-host': 'tunnel.example.com',
            })
          )
          expect(body.issuer).toBe('http://127.0.0.1:3000/fhir-r4')
          expect(body.jwks_uri).toBe('http://127.0.0.1:3000/.well-known/jwks.json')
        })
      )
    ))

  test('falls back to the configured Origin when the peer is not loopback', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wired = yield* wireServerScoped
          const body = yield* Effect.promise(() =>
            fetchSmartConfig(wired.handler, {
              // `x-test-remote-address` is consumed by the test middleware in
              // `server-helpers.ts` and becomes `request.remoteAddress`. A
              // non-loopback peer here simulates an attacker reaching an
              // `HOSTNAME=0.0.0.0`-bound server with forged loopback headers.
              'x-test-remote-address': '203.0.113.1',
              host: '127.0.0.1:3000',
              'x-forwarded-host': 'evil.example.com',
              'x-forwarded-proto': 'https',
            })
          )
          expect(body.issuer).toBe(`${ORIGIN}/fhir-r4`)
          expect(body.jwks_uri).toBe(`${ORIGIN}/.well-known/jwks.json`)
        })
      )
    ))
})
