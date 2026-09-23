import { HttpClient, HttpClientResponse } from '@effect/platform'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Effect, Layer } from 'effect'
import { buildSmartRouterContext } from 'fhir-r4-react/smart'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { traceExchangeToWire } from 'web-trace-core/codec'
import { traceExchange } from 'web-trace-core/test-helpers'

import { TraceApp } from './app.tsx'

/**
 * The app's own wiring, end to end: its router context satisfies
 * `web-trace-react`'s `useRunAuthed`, its HTTP layer addresses the FHIR server
 * the SMART handshake named and carries the granted token, and the panel it
 * mounts walks all the way down to one exchange's detail.
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
  // the granted token is the app's only credential.
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

  /** Walk the panel down from the sessions list to one exchange's detail. */
  const openTheDetail = async (url: string): Promise<void> => {
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
  }

  it('should open an exchange detail, which the panel owns', async () => {
    // Arrange
    const url = 'https://portal.example.org/api/v2/patients/8f14e45f'

    // Act
    await openTheDetail(url)

    // Assert — the detail names what the capture could not observe, rather than
    // letting a reader assume a GET. Both `getByRole` calls raise on a second
    // match, which is what catches a detail surface reappearing in this app:
    // it would open alongside the panel's, not instead of it. The URL is matched
    // inside the article because the panel's session header shows it too.
    const detail = screen.getByRole('article')
    expect(within(detail).getByText(url)).toBeDefined()
    expect(within(detail).getByText(/records no request method/)).toBeDefined()
    expect(screen.getByRole('button', { name: 'Back to exchanges' })).toBeDefined()
  })

  it('should return from an exchange detail to the exchange list', async () => {
    // Arrange
    const url = 'https://portal.example.org/api/v2/patients/8f14e45f'
    await openTheDetail(url)

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Back to exchanges' }))

    // Assert — back to the *exchange* list of the session that was open, not to
    // the sessions list. The panel's "All recordings" control is what tells the
    // two apart: a session row's subtitle is its host, so a URL match alone
    // passes on either surface.
    expect(screen.getByRole('button', { name: 'All recordings' })).toBeDefined()
    expect(screen.getByRole('button', { name: new RegExp('portal\\.example\\.org') })).toBeDefined()
  })

  // The tabstrip is the only navigation this app owns. Everything below a tab
  // belongs to the slice panel that tab selects.
  it('should swap the recordings panel for the documents panel, unmounting the one it leaves', async () => {
    // Arrange
    mount(searchset([traceExchangeToWire(traceExchange({ sessionId: 'morning', requestId: 'a' }))]))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /morning/ })).toBeDefined()
    })

    // Act
    await userEvent.click(screen.getByRole('tab', { name: 'Documents' }))

    // Assert — the documents browser's own filter bar is up, and the recordings
    // panel is *gone* rather than hidden. A `hidden` wrapper is what made the
    // last two-surfaces-at-once collision invisible to every query but one, so
    // this asserts the absence directly.
    await waitFor(() => {
      expect(screen.getByLabelText('Category')).toBeDefined()
    })
    expect(screen.queryByRole('button', { name: /morning/ })).toBeNull()
    expect(screen.queryByLabelText('URL contains')).toBeNull()
  })

  it('should return to the recordings panel from the documents tab', async () => {
    // Arrange
    mount(searchset([traceExchangeToWire(traceExchange({ sessionId: 'morning', requestId: 'a' }))]))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /morning/ })).toBeDefined()
    })
    await userEvent.click(screen.getByRole('tab', { name: 'Documents' }))
    await waitFor(() => {
      expect(screen.getByLabelText('Category')).toBeDefined()
    })

    // Act
    await userEvent.click(screen.getByRole('tab', { name: 'Recordings' }))

    // Assert
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /morning/ })).toBeDefined()
    })
    expect(screen.queryByLabelText('Category')).toBeNull()
  })
})
