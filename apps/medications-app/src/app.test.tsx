import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type Client from 'fhirclient/lib/Client'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import type { MedicationRequestPage, SmartHandshake } from 'fhir-r4-react/smart'

// The two seams `App` composes: the handshake hook (its state is driven per
// test) and the paged MedicationRequest read (whose page / rejection is stubbed).
// The real `useSmartHandshake` dedup is covered in the slice; here we drive its
// result to exercise `App`'s own query wiring, paging, and error surfacing.
const { handshakeMock, fetchMock } = vi.hoisted(() => ({
  handshakeMock: vi.fn<() => SmartHandshake>(),
  fetchMock: vi.fn<() => Promise<MedicationRequestPage>>(),
}))
vi.mock('fhir-r4-react/smart', () => ({
  useSmartHandshake: () => handshakeMock(),
  fetchMedicationRequestPage: () => fetchMock(),
}))

const { App } = await import('./app.tsx')

// The client is only ever forwarded to the (mocked) read, so its shape is unused.
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test-only stub, forwarded to a mock
const readyHandshake: SmartHandshake = { kind: 'ready', client: {} as unknown as Client }

/** An empty terminal page — no rows, no further cursor. */
const lastPage: MedicationRequestPage = { items: [], nextPageUrl: null }

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
  vi.unstubAllGlobals()
  handshakeMock.mockReset()
  fetchMock.mockReset()
})

describe('App', () => {
  it('should read MedicationRequests once the handshake resolves — and only once under StrictMode', async () => {
    // Arrange
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock.mockResolvedValue(lastPage)

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

  it('should load the next page when the bottom sentinel scrolls into view', async () => {
    // Arrange: capture a `trigger` for every IntersectionObserver so the test can
    // simulate the sentinel entering the viewport. `stubGlobal` is untyped, so the
    // stub's callback param can name just the field the app reads — no casts, and
    // only the two methods the app calls (`observe`/`disconnect`) are needed.
    const observers: { readonly trigger: () => void }[] = []
    class MockIntersectionObserver {
      readonly #notify: () => void
      constructor(callback: (entries: readonly { readonly isIntersecting: boolean }[]) => void) {
        this.#notify = () => {
          callback([{ isIntersecting: true }])
        }
        observers.push({ trigger: this.#notify })
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)

    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock
      .mockResolvedValueOnce({
        items: [],
        nextPageUrl: 'https://fhir.example/MedicationRequest?p=2',
      })
      .mockResolvedValueOnce(lastPage)

    // Act: first page settles, so the sentinel mounts and an observer is built.
    renderApp()
    await waitFor(() => {
      expect(observers.length).toBeGreaterThan(0)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Simulate the sentinel entering the viewport.
    act(() => {
      observers.at(-1)?.trigger()
    })

    // Assert: the next page is fetched, then paging stops (terminal page).
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })
  })
})
