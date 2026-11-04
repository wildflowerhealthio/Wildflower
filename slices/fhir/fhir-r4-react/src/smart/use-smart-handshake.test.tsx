import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { AuthorizationRejected } from '@wildflowerhealthio/authorization-core/smart-client'
import { Effect } from 'effect'
import { StrictMode, type JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { RootArrival } from './root-arrival.ts'
import type { SignInAfterRedirectError, SignInLanding } from './sign-in-after-redirect.ts'
import type { SmartConnection } from './smart-connection.ts'
import { stubConnection } from './test-helpers.ts'

// The exchange is the one thing worth stubbing: it is the single-use POST this
// hook exists to fire exactly once. `vi.hoisted` so the spy exists before the
// module mock that closes over it is applied.
const { completeMock } = vi.hoisted(() => ({
  completeMock:
    vi.fn<
      (
        landing: Pick<SignInLanding, 'arrival' | 'registration' | 'appRootRedirectUri'>
      ) => Effect.Effect<SmartConnection, SignInAfterRedirectError>
    >(),
}))
vi.mock('./sign-in-after-redirect.ts', () => ({ completeSignInAfterRedirectHere: completeMock }))

const { isSmartHandshakeQuery, useSmartHandshake } = await import('./use-smart-handshake.ts')

// The hook only ever hands the connection back, so any connection will do.
const connection = stubConnection()

/** The sign-in the page landed on: a return to the app served from `/app/`. */
const LANDING = {
  arrival: RootArrival.SignInReturn({ code: 'code-1', state: 'state-1' }),
  registration: { clientId: 'medication-app', scope: 'launch openid' },
  appRootRedirectUri: 'https://apps.example/app/',
}

/** Runs the handshake for {@link LANDING}, rendering its `_tag`. */
const Probe = (): JSX.Element => <span>{useSmartHandshake(LANDING)._tag}</span>

/**
 * Mount `Probe` under `StrictMode` — whose dev double-mount is exactly what
 * would double-POST a bare `useEffect` exchange — over a plain `QueryClient`
 * with retries left on, so the hook's own `retry: false` is what's under test.
 */
const mountUnderStrictMode = (queryClient: QueryClient = new QueryClient()): void => {
  render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>
    </StrictMode>
  )
}

afterEach(() => {
  cleanup()
  completeMock.mockReset()
})

describe('useSmartHandshake', () => {
  it('should exchange the code exactly once despite StrictMode double-mount', async () => {
    // Arrange
    completeMock.mockReturnValue(Effect.succeed(connection))

    // Act
    mountUnderStrictMode()

    // Assert
    await waitFor(() => {
      expect(screen.getByText('Ready')).toBeDefined()
    })
    expect(completeMock).toHaveBeenCalledTimes(1)
  })

  it('should complete the landing it was handed', async () => {
    // Arrange
    completeMock.mockReturnValue(Effect.succeed(connection))

    // Act
    mountUnderStrictMode()

    // Assert
    await waitFor(() => {
      expect(screen.getByText('Ready')).toBeDefined()
    })
    expect(completeMock).toHaveBeenCalledExactlyOnceWith(LANDING)
  })

  it('should surface a failed exchange without re-POSTing the consumed code', async () => {
    // Arrange
    completeMock.mockReturnValue(
      Effect.fail(new AuthorizationRejected({ reason: 'authorization code already redeemed' }))
    )

    // Act
    mountUnderStrictMode()

    // Assert
    await waitFor(() => {
      expect(screen.getByText('Failed')).toBeDefined()
    })
    // `retry: false` holds even though the QueryClient's default retry is 3 —
    // re-sending a single-use code cannot succeed.
    expect(completeMock).toHaveBeenCalledTimes(1)
  })
})

describe('isSmartHandshakeQuery', () => {
  it('should pick out the handshake query from the app’s own reads', async () => {
    // Arrange — the handshake and one of the app's reads on one client
    completeMock.mockReturnValue(Effect.succeed(connection))
    const queryClient = new QueryClient()
    mountUnderStrictMode(queryClient)
    await queryClient.query({
      queryKey: ['fhir-r4-react', 'smart-handshake', 'patient'],
      queryFn: () => Promise.resolve('patient'),
    })
    await waitFor(() => {
      expect(screen.getByText('Ready')).toBeDefined()
    })

    // Act
    const handshakeKeys = queryClient
      .getQueryCache()
      .getAll()
      .filter(isSmartHandshakeQuery)
      .map((query) => query.queryKey)

    // Assert — the exact key only, not one it prefixes
    expect(handshakeKeys).toStrictEqual([['fhir-r4-react', 'smart-handshake']])
  })
})
