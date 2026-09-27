import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Effect, Either, Layer } from 'effect'
import type * as SmartModule from 'fhir-r4-react/smart'
import type { SmartHandshake } from 'fhir-r4-react/smart'
import type Client from 'fhirclient/lib/Client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import type * as PebbleSettings from './pebble-settings.ts'
import type * as ReturnTargetStore from './return-target-store.ts'
import * as ReturnTarget from './return-target.ts'

/**
 * The app's own wiring. `App` is driven through a stubbed handshake; everything
 * past the handshake runs through `SettingsApp` over the real
 * `buildSmartRouterContext` with only the transport stubbed, so the patient
 * read goes through the router context, the typed FHIR client and the SMART
 * HTTP layer exactly as in production — and what reaches the wire is asserted
 * here, because no test one layer down can see it.
 */

const { handshakeMock } = vi.hoisted(() => ({
  handshakeMock: vi.fn<() => SmartHandshake>(),
}))
vi.mock('fhir-r4-react/smart', async (importOriginal) => ({
  ...(await importOriginal<typeof SmartModule>()),
  useSmartHandshake: () => handshakeMock(),
  useLaunchFailureRedirect: (): void => undefined,
}))

const { buildSmartRouterContext } = await import('fhir-r4-react/smart')
const { App, SettingsApp } = await import('./app.tsx')

const SERVER_URL = 'https://fhir.example/r4'
const ACCESS_TOKEN = 'watch-token'

/** Every request the stub server saw, in order. */
let recorded: { readonly url: string; readonly authorization: string | undefined }[] = []

beforeEach(() => {
  recorded = []
  handshakeMock.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('App', () => {
  it('should show the connecting state while the handshake is in flight', () => {
    // Arrange
    handshakeMock.mockReturnValue({ kind: 'connecting' })

    // Act
    renderApp()

    // Assert
    expect(screen.getByText('Connecting…')).toBeDefined()
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
  })

  it("should take the settings page's refusal from what the grant lacked", async () => {
    // Arrange — the server completed the handshake with no patient in context
    handshakeMock.mockReturnValue({ kind: 'ready', client: grantedClient({ patientId: null }) })

    // Act
    renderApp()

    // Assert
    expect(
      await screen.findByRole('heading', { level: 1, name: 'FHIR Sync for Pebble' })
    ).toBeDefined()
    expect(screen.getByText(/did not grant a patient/)).toBeDefined()
  })
})

describe('SettingsApp', () => {
  it('should show the patient the server put in context', async () => {
    // Act
    mount({ server: servingAda })

    // Assert
    expect(await screen.findByText('Ada Lovelace')).toBeDefined()
  })

  it('should read the patient from the FHIR server the handshake named, with the granted token', async () => {
    // Act
    mount({ server: servingAda })
    await screen.findByText('Ada Lovelace')

    // Assert
    expect(recorded).toEqual([
      { url: `${SERVER_URL}/Patient/ada`, authorization: `Bearer ${ACCESS_TOKEN}` },
    ])
  })

  it('should send the settings back to the Pebble app on save, naming the patient it read', async () => {
    // Arrange
    const user = userEvent.setup()
    const navigate = vi.fn<(url: string) => void>()
    mount({ server: servingAda, returnTo: 'http://localhost:61234/close?', navigate })
    await screen.findByText('Ada Lovelace')

    // Act
    await user.click(screen.getByRole('button', { name: 'Save to watch' }))

    // Assert
    expect(navigate).toHaveBeenCalledWith(
      'http://localhost:61234/close?' +
        encodeURIComponent(
          JSON.stringify({
            patientId: 'ada',
            patientName: 'Ada Lovelace',
            patientBirthDate: '1815-12-10',
            accessToken: ACCESS_TOKEN,
            fhirBaseUrl: SERVER_URL,
          })
        )
    )
  })

  it('should hold the save until the patient has been read', async () => {
    // Act — the server never answers
    mount({ server: () => Effect.never })

    // Assert
    const save = await screen.findByRole('button', { name: 'Save to watch' })
    expect(save.hasAttribute('disabled')).toBe(true)
  })

  it('should block the save when the granted token cannot read the patient', async () => {
    // Act
    mount({ server: (request) => Effect.succeed(respond(request, 403, {})) })

    // Assert
    await waitFor(() => {
      expect(screen.queryByText('Reading the patient…')).toBeNull()
    })
    expect(screen.queryByText('Ada Lovelace')).toBeNull()
    expect(screen.getByRole('button', { name: 'Save to watch' }).hasAttribute('disabled')).toBe(
      true
    )
  })
})

// Helpers

type Server = (
  request: Parameters<Parameters<typeof HttpClient.make>[0]>[0]
) => Effect.Effect<HttpClientResponse.HttpClientResponse>

/** A JSON response to `request`. */
const respond = (
  request: Parameters<Server>[0],
  status: number,
  body: unknown
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/fhir+json' },
    })
  )

/** A server holding one patient, Ada Lovelace, under id `ada`. */
const servingAda: Server = (request) =>
  Effect.succeed(
    respond(request, 200, {
      resourceType: 'Patient',
      id: 'ada',
      name: [{ given: ['Ada'], family: 'Lovelace' }],
      birthDate: '1815-12-10',
    })
  )

/** A transport over `server` that records each request it is sent. */
const recordingTransport = (server: Server): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      recorded.push({ url: request.url, authorization: request.headers['authorization'] })
      return server(request)
    })
  )

/** Mounts `SettingsApp` for Ada's grant against `server`. */
const mount = ({
  server,
  returnTo = ReturnTarget.DEFAULT,
  navigate = (): void => undefined,
}: {
  readonly server: Server
  readonly returnTo?: string
  readonly navigate?: (url: string) => void
}): void => {
  const context = buildSmartRouterContext(
    { serverUrl: SERVER_URL, accessToken: ACCESS_TOKEN },
    recordingTransport(server),
    new QueryClient({ defaultOptions: { queries: { retry: false } } })
  )
  const returnTargets: ReturnTargetStore.Store = {
    rememberFrom: (): void => undefined,
    recall: () => ReturnTarget.decode(returnTo),
  }
  render(
    <SettingsApp
      context={context}
      connection={Either.right({
        patientId: 'ada',
        accessToken: ACCESS_TOKEN,
        fhirBaseUrl: SERVER_URL,
      } satisfies PebbleSettings.Connection)}
      returnTargets={returnTargets}
      navigate={navigate}
    />
  )
}

/** Renders `App` under a retry-free query client. */
const renderApp = (): void => {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <App />
    </QueryClientProvider>
  )
}

/** A ready fhirclient `Client` carrying what the server granted. */
const grantedClient = ({ patientId }: { readonly patientId: string | null }): Client =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only stub: `App` reads only these fields
  ({
    patient: { id: patientId },
    state: { serverUrl: SERVER_URL, tokenResponse: { access_token: ACCESS_TOKEN } },
  }) as unknown as Client
