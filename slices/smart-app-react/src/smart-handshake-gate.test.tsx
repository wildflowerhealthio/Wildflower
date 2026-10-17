import { createMemoryHistory, type RouterHistory } from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import type * as FhirSmart from '@wildflowerhealthio/fhir-r4-react/smart'
import type { SmartHandshake } from '@wildflowerhealthio/fhir-r4-react/smart'
import type Client from 'fhirclient/lib/Client'
import { StrictMode, useState, type JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { LANDING_ROUTE_STORAGE_KEY } from './landing-route.ts'
import { SmartHandshakeGate } from './smart-handshake-gate.tsx'

// The handshake is the gate's one input: each test hands it a state, and reads
// back what the gate renders and what it carries to the app root.
const { handshakeMock, launchFailureRedirectMock } = vi.hoisted(() => ({
  handshakeMock: vi.fn<() => SmartHandshake>(),
  launchFailureRedirectMock: vi.fn<(handshake: SmartHandshake) => void>(),
}))
vi.mock('@wildflowerhealthio/fhir-r4-react/smart', async (importOriginal) => ({
  ...(await importOriginal<typeof FhirSmart>()),
  useSmartHandshake: handshakeMock,
  useLaunchFailureRedirect: launchFailureRedirectMock,
}))

afterEach(() => {
  cleanup()
  handshakeMock.mockReset()
  launchFailureRedirectMock.mockReset()
  window.sessionStorage.clear()
})

/** A client the gate only forwards to its children, whose launch put patient `p1` in context. */
const client =
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test-only stub, forwarded to the children
  { state: { serverUrl: 'https://fhir.example/r4' }, patient: { id: 'p1' } } as unknown as Client

/** A `landsOn` opening the launch's patient. */
const landsOnLaunchPatient = (ready: Client): string => `/patients/${ready.patient.id ?? ''}`

/**
 * The gate over a page at the app root, its children naming the server of the
 * client they were handed and the route the history was at as they first
 * rendered; returns the page's history.
 */
const renderGate = ({
  landsOn,
}: { readonly landsOn?: (ready: Client) => string } = {}): RouterHistory => {
  const history = createMemoryHistory({ initialEntries: ['/'] })
  const AppStub = ({ serverUrl }: { readonly serverUrl: string }): JSX.Element => {
    const [route] = useState(() => history.location.href)
    return (
      <p>
        App over {serverUrl} at {route}
      </p>
    )
  }
  render(
    <StrictMode>
      <SmartHandshakeGate
        page={{ history, basepath: '/' }}
        connecting={<p>Connecting…</p>}
        landsOn={landsOn}
      >
        {(ready) => <AppStub serverUrl={ready.state.serverUrl} />}
      </SmartHandshakeGate>
    </StrictMode>
  )
  return history
}

describe('SmartHandshakeGate', () => {
  it('should show the connecting element, not the app, while the exchange runs', () => {
    handshakeMock.mockReturnValue({ kind: 'connecting' })

    renderGate()

    expect(screen.getByText('Connecting…')).toBeDefined()
    expect(screen.queryByText(/App over/)).toBeNull()
  })

  it('should render the app over the client once the handshake is ready', () => {
    handshakeMock.mockReturnValue({ kind: 'ready', client })

    renderGate()

    expect(screen.getByText('App over https://fhir.example/r4 at /')).toBeDefined()
  })

  it('should restore the route the launch landed on before the app first renders', () => {
    // Arrange
    window.sessionStorage.setItem(LANDING_ROUTE_STORAGE_KEY, '/calendar?patient=123')
    handshakeMock.mockReturnValue({ kind: 'ready', client })

    // Act — under StrictMode, which renders the gate twice
    const history = renderGate()

    // Assert — one replace, seen by the app's first render, and the key spent
    expect(
      screen.getByText('App over https://fhir.example/r4 at /calendar?patient=123')
    ).toBeDefined()
    expect(history.length).toBe(1)
    expect(window.sessionStorage.getItem(LANDING_ROUTE_STORAGE_KEY)).toBeNull()
  })

  it('should open the landsOn route when the launch kept none, in one entry', () => {
    // Arrange
    handshakeMock.mockReturnValue({ kind: 'ready', client })

    // Act — under StrictMode, which renders the gate twice
    const history = renderGate({ landsOn: landsOnLaunchPatient })

    // Assert
    expect(screen.getByText('App over https://fhir.example/r4 at /patients/p1')).toBeDefined()
    expect(history.length).toBe(1)
  })

  it('should open the kept route over the landsOn route', () => {
    // Arrange
    window.sessionStorage.setItem(LANDING_ROUTE_STORAGE_KEY, '/patients/p2/plan')
    handshakeMock.mockReturnValue({ kind: 'ready', client })

    // Act
    const history = renderGate({ landsOn: landsOnLaunchPatient })

    // Assert
    expect(screen.getByText('App over https://fhir.example/r4 at /patients/p2/plan')).toBeDefined()
    expect(history.length).toBe(1)
  })

  it('should keep the kept route while the exchange runs', () => {
    window.sessionStorage.setItem(LANDING_ROUTE_STORAGE_KEY, '/calendar')
    handshakeMock.mockReturnValue({ kind: 'connecting' })

    const history = renderGate()

    expect(history.location.href).toBe('/')
    expect(window.sessionStorage.getItem(LANDING_ROUTE_STORAGE_KEY)).toBe('/calendar')
  })

  it('should show a failed exchange and carry it to the app root, without the app', () => {
    const handshake: SmartHandshake = { kind: 'error', error: new Error('code already redeemed') }
    handshakeMock.mockReturnValue(handshake)

    renderGate()

    expect(screen.getByText('code already redeemed')).toBeDefined()
    expect(screen.queryByText(/App over/)).toBeNull()
    expect(launchFailureRedirectMock).toHaveBeenCalledWith(handshake)
  })
})
