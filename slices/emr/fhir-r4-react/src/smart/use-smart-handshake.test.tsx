import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type Client from 'fhirclient/lib/Client'
import { StrictMode, type JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

// The exchange is the one thing worth stubbing: it is the single-use POST this
// hook exists to fire exactly once. `vi.hoisted` so the spy exists before the
// module mock that closes over it is applied.
const { readyMock } = vi.hoisted(() => ({ readyMock: vi.fn<() => Promise<Client>>() }))
vi.mock('./smart-launch.ts', () => ({ readySmartClient: readyMock }))

const { useSmartHandshake } = await import('./use-smart-handshake.ts')

// A `Client` stub: the hook only ever hands it back, so nothing reads its shape.
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test-only stub, never structurally read
const fakeClient = {} as unknown as Client

/** Renders the handshake's `kind`, so the test asserts on visible text. */
const Probe = (): JSX.Element => <span>{useSmartHandshake().kind}</span>

/**
 * Mount `Probe` under `StrictMode` — whose dev double-mount is exactly what
 * would double-POST a bare `useEffect` exchange — over a plain `QueryClient`
 * with retries left on, so the hook's own `retry: false` is what's under test.
 */
const mountUnderStrictMode = (): void => {
  render(
    <StrictMode>
      <QueryClientProvider client={new QueryClient()}>
        <Probe />
      </QueryClientProvider>
    </StrictMode>
  )
}

afterEach(() => {
  cleanup()
  readyMock.mockReset()
})

describe('useSmartHandshake', () => {
  it('should exchange the code exactly once despite StrictMode double-mount', async () => {
    // Arrange
    readyMock.mockResolvedValue(fakeClient)

    // Act
    mountUnderStrictMode()

    // Assert
    await waitFor(() => {
      expect(screen.getByText('ready')).toBeDefined()
    })
    expect(readyMock).toHaveBeenCalledTimes(1)
  })

  it('should surface a failed exchange without re-POSTing the consumed code', async () => {
    // Arrange
    readyMock.mockRejectedValue(new Error('authorization code already redeemed'))

    // Act
    mountUnderStrictMode()

    // Assert
    await waitFor(() => {
      expect(screen.getByText('error')).toBeDefined()
    })
    // `retry: false` holds even though the QueryClient's default retry is 3 —
    // re-sending a single-use code cannot succeed.
    expect(readyMock).toHaveBeenCalledTimes(1)
  })
})
