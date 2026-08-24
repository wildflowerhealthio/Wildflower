import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type Client from 'fhirclient/lib/Client'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import type { SmartHandshake } from 'fhir-r4-react/smart'

// The two seams `App` composes: the handshake hook (its state is driven per
// test) and the MedicationRequest read (whose return / rejection is stubbed).
// The real `useSmartHandshake` dedup is covered in the slice; here we drive its
// result to exercise `App`'s own query wiring and error surfacing.
const { handshakeMock, fetchMock } = vi.hoisted(() => ({
  handshakeMock: vi.fn<() => SmartHandshake>(),
  fetchMock: vi.fn<() => Promise<readonly unknown[]>>(),
}))
vi.mock('fhir-r4-react/smart', () => ({
  useSmartHandshake: () => handshakeMock(),
  fetchMedicationRequests: () => fetchMock(),
}))

const { App } = await import('./app.tsx')

// The client is only ever forwarded to the (mocked) read, so its shape is unused.
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test-only stub, forwarded to a mock
const readyHandshake: SmartHandshake = { kind: 'ready', client: {} as unknown as Client }

/** Render `App` under StrictMode over a retry-free client (fast failures). */
const renderApp = (): void => {
  render(
    <StrictMode>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <App />
      </QueryClientProvider>
    </StrictMode>
  )
}

afterEach(() => {
  cleanup()
  handshakeMock.mockReset()
  fetchMock.mockReset()
})

describe('App', () => {
  it('should read MedicationRequests once the handshake resolves — and only once under StrictMode', async () => {
    // Arrange
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock.mockResolvedValue([])

    // Act
    renderApp()

    // Assert
    await waitFor(() => {
      expect(screen.queryByText('Loading medications…')).toBeNull()
    })
    expect(screen.queryByText(/Could not load medications/)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('should not read MedicationRequests until the handshake resolves', () => {
    // Arrange
    handshakeMock.mockReturnValue({ kind: 'connecting' })

    // Act
    renderApp()

    // Assert
    expect(screen.getByText('Loading medications…')).toBeDefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('should surface a failed token exchange without attempting the read', () => {
    // Arrange
    handshakeMock.mockReturnValue({ kind: 'error', error: new Error('token exchange failed') })

    // Act
    renderApp()

    // Assert
    expect(screen.getByText('Could not load medications: token exchange failed')).toBeDefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('should surface a failed MedicationRequest read', async () => {
    // Arrange
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock.mockRejectedValue(new Error('read failed'))

    // Act
    renderApp()

    // Assert
    await waitFor(() => {
      expect(screen.getByText('Could not load medications: read failed')).toBeDefined()
    })
  })
})
