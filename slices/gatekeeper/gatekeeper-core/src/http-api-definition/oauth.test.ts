// @vitest-environment jsdom
// HttpApiClient builds requests with relative URLs (`/oauth/token`).
// Node's default URL parser rejects relative URLs without a base;
// jsdom provides `window.location.href` so resolution works.
import { HttpApiClient, HttpClient, HttpClientResponse } from '@effect/platform'
import { Effect, Layer } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { GatekeeperApi } from './index.ts'

describe('TokenExchange wire format', () => {
  // RFC 6749 §3.2: token endpoint requests are
  // `application/x-www-form-urlencoded`. The Rust gatekeeper enforces
  // that (`serde_urlencoded` only); the TS server is lenient. This
  // pins the *client* side: an encoding annotation on the payload
  // union wrapper (instead of on each member) is silently ignored by
  // `HttpApiClient`'s encoder and the request goes out as JSON.
  test('encodes the device-code payload as form-urlencoded', async () => {
    // Arrange
    const captures: CapturedRequest[] = []

    // Act
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(GatekeeperApi)
        return yield* client.oauth.TokenExchange({
          payload: {
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            client_id: 'wildflower-host',
            device_code: 'dev-1',
          },
        })
      }).pipe(Effect.provide(capturingHttpClientLayer(captures)), Effect.scoped)
    )

    // Assert
    expect(captures).toEqual([
      {
        contentType: 'application/x-www-form-urlencoded',
        bodyText:
          'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&client_id=wildflower-host&device_code=dev-1',
      },
    ])
  })

  test('encodes the authorization-code payload as form-urlencoded', async () => {
    // Arrange
    const captures: CapturedRequest[] = []
    const verifier = 'v'.repeat(43)

    // Act
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(GatekeeperApi)
        return yield* client.oauth.TokenExchange({
          payload: {
            grant_type: 'authorization_code',
            client_id: 'wildflower-host',
            code: 'code-1',
            code_verifier: verifier,
            redirect_uri: 'http://127.0.0.1:8080/callback',
          },
        })
      }).pipe(Effect.provide(capturingHttpClientLayer(captures)), Effect.scoped)
    )

    // Assert
    expect(captures).toEqual([
      {
        contentType: 'application/x-www-form-urlencoded',
        bodyText: `grant_type=authorization_code&client_id=wildflower-host&code=code-1&code_verifier=${verifier}&redirect_uri=http%3A%2F%2F127.0.0.1%3A8080%2Fcallback`,
      },
    ])
  })

  // The third grant the server dispatches (`token_exchange.rs`). Mirrors the two
  // cases above so the per-member form encoding is guarded for every union
  // member, not just the first two (the drift test checks schema shape, not
  // wire encoding, so it can't catch a re-hoisted `withEncoding`).
  test('encodes the refresh-token payload as form-urlencoded', async () => {
    // Arrange
    const captures: CapturedRequest[] = []

    // Act
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(GatekeeperApi)
        return yield* client.oauth.TokenExchange({
          payload: {
            grant_type: 'refresh_token',
            client_id: 'wildflower-host',
            refresh_token: 'rt-1',
          },
        })
      }).pipe(Effect.provide(capturingHttpClientLayer(captures)), Effect.scoped)
    )

    // Assert
    expect(captures).toEqual([
      {
        contentType: 'application/x-www-form-urlencoded',
        bodyText: 'grant_type=refresh_token&client_id=wildflower-host&refresh_token=rt-1',
      },
    ])
  })
})

describe('DeviceAuthorization wire format', () => {
  // The device-authorization request is form-urlencoded like the token grants.
  // Pins that the `device_name` RFC 8628 extension rides the body (snake_case),
  // so the requesting device's chosen name actually reaches the server.
  test('encodes scope + device_name as form-urlencoded', async () => {
    // Arrange
    const captures: CapturedRequest[] = []

    // Act — the canned reply is token-shaped, so decoding the device-auth
    // response fails after the request is captured; we only assert the wire.
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(GatekeeperApi)
        return yield* client.oauth.DeviceAuthorization({
          payload: {
            client_id: 'wildflower-host',
            scope: 'system/*.cruds',
            device_name: "Ada's laptop",
          },
        })
      }).pipe(Effect.provide(capturingHttpClientLayer(captures)), Effect.scoped)
    ).catch(() => undefined)

    // Assert
    expect(captures).toEqual([
      {
        contentType: 'application/x-www-form-urlencoded',
        bodyText: 'client_id=wildflower-host&scope=system%2F*.cruds&device_name=Ada%27s+laptop',
      },
    ])
  })
})

// Helpers

interface CapturedRequest {
  readonly contentType: string | undefined
  readonly bodyText: string
}

/**
 * `HttpClient` stub that records each request's body content type and
 * raw text, replying with a canned token response — just enough to
 * observe the encoder's wire output.
 */
const capturingHttpClientLayer = (
  captures: CapturedRequest[]
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const body = request.body
        captures.push({
          contentType: body.contentType,
          bodyText:
            body._tag === 'Uint8Array' ? new TextDecoder().decode(body.body) : `(${body._tag})`,
        })
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              access_token: 'token-1',
              token_type: 'bearer',
              expires_in: 3600,
              scope: 'owner',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        )
      })
    )
  )
