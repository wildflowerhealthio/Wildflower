import { cleanup, render, screen } from '@testing-library/react'
import type * as FhirSmart from '@wildflowerhealthio/fhir-r4-react/smart'
import type { SmartHandshake } from '@wildflowerhealthio/fhir-r4-react/smart'
import type Client from 'fhirclient/lib/Client'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

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
})

/** A client the gate only forwards to its children. */
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test-only stub, forwarded to the children
const client = { state: { serverUrl: 'https://fhir.example/r4' } } as unknown as Client

/** The gate, its children naming the server of the client they were handed. */
const renderGate = (): void => {
  render(
    <SmartHandshakeGate connecting={<p>Connecting…</p>}>
      {(ready) => <p>App over {ready.state.serverUrl}</p>}
    </SmartHandshakeGate>
  )
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

    expect(screen.getByText('App over https://fhir.example/r4')).toBeDefined()
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
