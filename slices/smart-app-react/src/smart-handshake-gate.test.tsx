import { cleanup, render, screen } from '@testing-library/react'
import { AuthorizationRejected } from '@wildflowerhealthio/authorization-core/smart-client'
import type * as FhirSmart from '@wildflowerhealthio/fhir-r4-react/smart'
import {
  RootArrival,
  SmartHandshake,
  type SignInLanding,
  useRunSmart,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import { Effect } from 'effect'
import { useEffect, useState, type JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { stubConnection } from '@wildflowerhealthio/fhir-r4-react/smart/test-helpers'
import { SignInLandingContext } from './sign-in-landing.ts'
import { SmartHandshakeGate } from './smart-handshake-gate.tsx'

// The handshake is the gate's one input: each test hands it a state, and reads
// back what the gate renders and what it carries to the app root.
const { handshakeMock, redirectToRootMock } = vi.hoisted(() => ({
  handshakeMock: vi.fn<(landing: SignInLanding) => SmartHandshake>(),
  redirectToRootMock: vi.fn<(handshake: SmartHandshake, appRootRedirectUri: string) => void>(),
}))
vi.mock('@wildflowerhealthio/fhir-r4-react/smart', async (importOriginal) => ({
  ...(await importOriginal<typeof FhirSmart>()),
  useSmartHandshake: handshakeMock,
  useRedirectToRootOnFailure: redirectToRootMock,
}))

afterEach(() => {
  cleanup()
  handshakeMock.mockReset()
  redirectToRootMock.mockReset()
})

/** A connection the gate builds the app's runtime from. */
const connection = stubConnection()

/** The sign-in the app root landed on, and what it is told of the connection. */
const landingWith = (onSignedIn: SignInLanding['onSignedIn'] = vi.fn()): SignInLanding => ({
  arrival: RootArrival.SignInReturn({ code: 'code-1', state: 'state-1' }),
  registration: { clientId: 'medication-app', scope: 'launch openid' },
  appRootRedirectUri: 'https://apps.example/app/',
  onSignedIn,
})

/** A child that runs one Effect over the runtime the gate provides, and shows its answer. */
function RunsOverTheRuntime(): JSX.Element {
  const runSmart = useRunSmart()
  const [answer, setAnswer] = useState('')
  useEffect(() => {
    void runSmart(Effect.succeed('ran over the runtime')).then(setAnswer)
  }, [runSmart])
  return <p>{answer}</p>
}

/** The gate under `landing`, its children naming the server of the runtime they were handed. */
const renderGate = (landing: SignInLanding = landingWith()): void => {
  render(
    <SignInLandingContext value={landing}>
      <SmartHandshakeGate connecting={<p>Connecting…</p>}>
        {(runtime) => (
          <>
            <p>App over {runtime.connection.fhirBaseUrl}</p>
            <RunsOverTheRuntime />
          </>
        )}
      </SmartHandshakeGate>
    </SignInLandingContext>
  )
}

describe('SmartHandshakeGate', () => {
  it('should show the connecting element, not the app, while the exchange runs', () => {
    handshakeMock.mockReturnValue(SmartHandshake.Connecting())

    renderGate()

    expect(screen.getByText('Connecting…')).toBeDefined()
    expect(screen.queryByText(/App over/)).toBeNull()
  })

  it('should render the app over the runtime it built, provided to the tree, once ready', async () => {
    handshakeMock.mockReturnValue(SmartHandshake.Ready({ connection }))

    renderGate()

    expect(screen.getByText(`App over ${connection.fhirBaseUrl}`)).toBeDefined()
    expect(await screen.findByText('ran over the runtime')).toBeDefined()
  })

  it('should tell the landing the connection once ready', () => {
    const onSignedIn = vi.fn<(signedIn: typeof connection) => void>()
    handshakeMock.mockReturnValue(SmartHandshake.Ready({ connection }))

    renderGate(landingWith(onSignedIn))

    expect(onSignedIn).toHaveBeenCalledExactlyOnceWith(connection)
  })

  it('should run the handshake for the landing the root provides', () => {
    const landing = landingWith()
    handshakeMock.mockReturnValue(SmartHandshake.Connecting())

    renderGate(landing)

    expect(handshakeMock).toHaveBeenCalledWith(landing)
  })

  it('should show a failed exchange and carry it to the landing’s app root, without the app', () => {
    const handshake = SmartHandshake.Failed({
      error: new AuthorizationRejected({ reason: 'code already redeemed' }),
    })
    handshakeMock.mockReturnValue(handshake)

    renderGate()

    expect(screen.getByText('code already redeemed')).toBeDefined()
    expect(screen.queryByText(/App over/)).toBeNull()
    expect(redirectToRootMock).toHaveBeenCalledWith(handshake, 'https://apps.example/app/')
  })
})
