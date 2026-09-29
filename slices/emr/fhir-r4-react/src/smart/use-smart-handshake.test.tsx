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

const { isSmartHandshakeQuery, useSmartHandshake, whenSmartHandshakeReady } =
  await import('./use-smart-handshake.ts')

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

describe('whenSmartHandshakeReady', () => {
  it('should hand over the ready client once the handshake completes, once', async () => {
    // Arrange
    readyMock.mockResolvedValue(fakeClient)
    const queryClient = new QueryClient()
    const onReady = vi.fn<(client: Client) => void>()
    whenSmartHandshakeReady(queryClient, onReady)

    // Act
    mountUnderStrictMode(queryClient)

    // Assert
    await waitFor(() => {
      expect(onReady).toHaveBeenCalledWith(fakeClient)
    })
    await queryClient.invalidateQueries()
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('should hand over a client that was ready before it was asked', async () => {
    // Arrange — the handshake has already completed
    readyMock.mockResolvedValue(fakeClient)
    const queryClient = new QueryClient()
    mountUnderStrictMode(queryClient)
    await waitFor(() => {
      expect(screen.getByText('ready')).toBeDefined()
    })
    const onReady = vi.fn<(client: Client) => void>()

    // Act
    whenSmartHandshakeReady(queryClient, onReady)

    // Assert
    expect(onReady).toHaveBeenCalledExactlyOnceWith(fakeClient)
  })

  it('should never call back for a failed handshake, nor start one itself', async () => {
    // Arrange
    readyMock.mockRejectedValue(new Error('authorization code already redeemed'))
    const queryClient = new QueryClient()
    const onReady = vi.fn<(client: Client) => void>()
    whenSmartHandshakeReady(queryClient, onReady)
    expect(readyMock).not.toHaveBeenCalled()

    // Act
    mountUnderStrictMode(queryClient)

    // Assert
    await waitFor(() => {
      expect(screen.getByText('error')).toBeDefined()
    })
    expect(onReady).not.toHaveBeenCalled()
    expect(readyMock).toHaveBeenCalledTimes(1)
  })

  it('should stop listening once unsubscribed', async () => {
    // Arrange
    readyMock.mockResolvedValue(fakeClient)
    const queryClient = new QueryClient()
    const onReady = vi.fn<(client: Client) => void>()
    const stopListening = whenSmartHandshakeReady(queryClient, onReady)

    // Act
    stopListening()
    mountUnderStrictMode(queryClient)

    // Assert
    await waitFor(() => {
      expect(screen.getByText('ready')).toBeDefined()
    })
    expect(onReady).not.toHaveBeenCalled()
  })
})

describe('isSmartHandshakeQuery', () => {
  it('should pick out the handshake query from the app’s own reads', async () => {
    // Arrange — the handshake and one of the app's reads on one client
    readyMock.mockResolvedValue(fakeClient)
    const queryClient = new QueryClient()
    mountUnderStrictMode(queryClient)
    await queryClient.query({
      queryKey: ['fhir-r4-react', 'smart-handshake', 'patient'],
      queryFn: () => Promise.resolve('patient'),
    })
    await waitFor(() => {
      expect(screen.getByText('ready')).toBeDefined()
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
