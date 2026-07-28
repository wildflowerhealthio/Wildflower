import { HttpClient, HttpClientResponse } from '@effect/platform'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { traceExchangeToWire } from 'web-trace-core/codec'
import { traceExchange } from 'web-trace-core/test-helpers'

import { TraceApp } from './app.tsx'
import { buildSmartRouterContext } from './smart-runtime.ts'

/**
 * The app's own wiring, end to end: its router context satisfies
 * `web-trace-react`'s `useRunAuthed`, its HTTP layer addresses the FHIR server
 * the SMART handshake named and carries the granted token, and the exchange
 * detail the panel leaves to its host is rendered by this app.
 *
 * Only the transport is a stub. Everything above it — the router, the query,
 * the typed FHIR client, the codec — is the production path, so a break in any
 * of them fails here rather than only on a device.
 */

const SERVER_URL = 'http://127.0.0.1:8080/fhir-r4'
const ACCESS_TOKEN = 'tok-abc'

/** Every request the stub transport saw, in order. */
let sent: Array<{ readonly url: string; readonly authorization: string | undefined }> = []

afterEach(() => {
  cleanup()
  sent = []
})

const searchset = (resources: readonly unknown[]): unknown => ({
  resourceType: 'Bundle',
  type: 'searchset',
  entry: resources.map((resource) => ({ resource })),
  link: [],
})

/** A transport that records what it was asked for and answers with `body`. */
const serving = (body: unknown): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      sent.push({ url: request.url, authorization: request.headers['authorization'] })
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        )
      )
    })
  )

const mount = (body: unknown): void => {
  const context = buildSmartRouterContext(
    { serverUrl: SERVER_URL, accessToken: ACCESS_TOKEN },
    serving(body)
  )
  render(<TraceApp context={context} />)
}

describe('TraceApp', () => {
  it('should list the recordings on the device', async () => {
    // Arrange
    const body = searchset([
      traceExchangeToWire(traceExchange({ sessionId: 'morning', requestId: 'a' })),
      traceExchangeToWire(traceExchange({ sessionId: 'evening', requestId: 'b' })),
    ])

    // Act
    mount(body)

    // Assert
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /morning/ })).toBeDefined()
    })
    expect(screen.getByRole('button', { name: /evening/ })).toBeDefined()
  })

  // The two halves that a self-hosted origin makes non-obvious: the app is not
  // served by the API, so a relative path would resolve against port 8091, and
  // the API's cookie is not sent cross-origin so the token is the credential.
  it('should read from the FHIR server named by the handshake, with the granted token', async () => {
    // Arrange & Act
    mount(searchset([traceExchangeToWire(traceExchange({ sessionId: 'morning', requestId: 'a' }))]))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /morning/ })).toBeDefined()
    })

    // Assert
    expect(sent[0]?.url).toContain('http://127.0.0.1:8080/fhir-r4/DocumentReference')
    expect(sent[0]?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
  })

  it('should open an exchange detail, which the panel leaves to its host', async () => {
    // Arrange
    const url = 'https://portal.example.org/api/v2/patients/8f14e45f'
    mount(
      searchset([traceExchangeToWire(traceExchange({ sessionId: 'morning', requestId: 'a', url }))])
    )
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /morning/ })).toBeDefined()
    })
    await userEvent.click(screen.getByRole('button', { name: /morning/ }))

    // Act
    await userEvent.click(
      screen.getByRole('button', { name: new RegExp('portal\\.example\\.org') })
    )

    // Assert — the detail names what the capture could not observe, rather
    // than letting a reader assume a GET.
    expect(screen.getByRole('heading', { name: url })).toBeDefined()
    expect(screen.getByText(/carries no request method/)).toBeDefined()
  })

  it('should return from an exchange detail to the exchange list', async () => {
    // Arrange
    const url = 'https://portal.example.org/api/v2/patients/8f14e45f'
    mount(
      searchset([traceExchangeToWire(traceExchange({ sessionId: 'morning', requestId: 'a', url }))])
    )
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /morning/ })).toBeDefined()
    })
    await userEvent.click(screen.getByRole('button', { name: /morning/ }))
    await userEvent.click(
      screen.getByRole('button', { name: new RegExp('portal\\.example\\.org') })
    )

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Back to exchanges' }))

    // Assert
    expect(screen.getByRole('button', { name: new RegExp('portal\\.example\\.org') })).toBeDefined()
  })
})
