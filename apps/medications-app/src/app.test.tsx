import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type Client from 'fhirclient/lib/Client'
import type { InteractionCatalog } from 'medication-interaction-core'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import type { MedicationRequestPage, SmartHandshake } from 'fhir-r4-react/smart'

// The three seams `App` composes: the handshake hook (its state is driven per
// test), the paged MedicationRequest read (whose page / rejection is stubbed),
// and the DDInter catalog load (unresolved by default so interaction tests
// control it). The real `useSmartHandshake` dedup is covered in the slice;
// here we drive its result to exercise `App`'s own query wiring, paging, the
// load-everything driver, and error surfacing.
const { handshakeMock, fetchMock, catalogMock, launchFailureRedirectMock } = vi.hoisted(() => ({
  handshakeMock: vi.fn<() => SmartHandshake>(),
  fetchMock: vi.fn<() => Promise<MedicationRequestPage>>(),
  catalogMock: vi.fn<() => Promise<unknown>>(),
  launchFailureRedirectMock: vi.fn<(handshake: SmartHandshake) => void>(),
}))
vi.mock('fhir-r4-react/smart', async () => {
  const { Effect } = await import('effect')
  return {
    useSmartHandshake: () => handshakeMock(),
    useLaunchFailureRedirect: (handshake: SmartHandshake) => {
      launchFailureRedirectMock(handshake)
    },
    fetchMedicationRequestPage: () => Effect.promise(() => fetchMock()),
  }
})
vi.mock('./interaction-catalog.ts', () => ({
  getInteractionCatalog: () => catalogMock(),
}))

const { App } = await import('./app.tsx')

// The client is only ever forwarded to the (mocked) read, so its shape is unused.
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test-only stub, forwarded to a mock
const readyHandshake: SmartHandshake = { kind: 'ready', client: {} as unknown as Client }

/** An empty terminal page — no rows, no further cursor. */
const lastPage: MedicationRequestPage = { items: [], nextPageUrl: null, droppedEntryCount: 0 }

/** A non-terminal empty page pointing at the given next cursor. */
const pageTo = (next: number): MedicationRequestPage => ({
  items: [],
  nextPageUrl: `https://fhir.example/MedicationRequest?p=${next}`,
  droppedEntryCount: 0,
})

/** A valid, empty DDInter catalog — enough for the report shell to render. */
const emptyCatalog: InteractionCatalog = {
  source: { name: 'DDInter', url: 'https://ddinter.scbdd.com/' },
  drugs: [],
  pairs: new Map(),
}

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

/** Ready handshake + the given pages, ending on a terminal page. */
const arrangePages = (pageCount: number): void => {
  handshakeMock.mockReturnValue(readyHandshake)
  for (let page = 1; page < pageCount; page += 1) {
    fetchMock.mockResolvedValueOnce(pageTo(page + 1))
  }
  fetchMock.mockResolvedValueOnce(lastPage)
}

/** A quiet IntersectionObserver — the sentinel mounts but never fires. */
const stubQuietIntersectionObserver = (): void => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    }
  )
}

const awaitFirstPage = async (): Promise<void> => {
  await waitFor(() => {
    expect(screen.queryByText('Loading medications…')).toBeNull()
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  handshakeMock.mockReset()
  fetchMock.mockReset()
  catalogMock.mockReset()
  launchFailureRedirectMock.mockReset()
  // Unresolved by default: interaction tests opt into a resolved catalog.
  catalogMock.mockReturnValue(new Promise(() => {}))
})

describe('App', () => {
  it('should read MedicationRequests once the handshake resolves — and only once under StrictMode', async () => {
    // Arrange
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock.mockResolvedValue(lastPage)

    // Act
    renderApp()

    // Assert
    await awaitFirstPage()
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

    // Assert — the failure is announced as an alert, not a bare line
    expect(screen.getByRole('alert').textContent).toContain('token exchange failed')
    expect(fetchMock).not.toHaveBeenCalled()

    // ...and it is carried to the app root, which can offer the connect menu;
    // there is nothing to retry here, because the auth code is single-use.
    const [carried] = launchFailureRedirectMock.mock.calls[0] ?? []
    expect(carried?.kind).toBe('error')
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

  it('should offer all four views and default to Medications, with no province picker in the header', async () => {
    // Arrange
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock.mockResolvedValue(lastPage)

    // Act
    renderApp()

    // Assert
    await awaitFirstPage()
    for (const label of ['Medications', 'Calendar', 'Interactions', 'Savings']) {
      expect(screen.getByRole('button', { name: label })).toBeDefined()
    }
    expect(screen.getByRole('button', { name: 'Medications' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
    expect(screen.queryByRole('combobox', { name: 'Province' })).toBeNull()
    expect(screen.getByText('No medications found.')).toBeDefined()
  })

  it('should show the province picker and the program sections on the Savings view', async () => {
    // Arrange
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock.mockResolvedValue(lastPage)
    renderApp()
    await awaitFirstPage()

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Savings' }))

    // Assert
    expect(screen.getByRole('combobox', { name: 'Province' })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'innoviCares' })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'RxHelp' })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'No known savings program' })).toBeDefined()
  })

  it('should show the month grid on the Calendar view without any partial banner once loaded', async () => {
    // Arrange
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock.mockResolvedValue(lastPage)
    renderApp()
    await awaitFirstPage()

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Calendar' }))

    // Assert
    expect(screen.getByRole('button', { name: 'Next month' })).toBeDefined()
    expect(screen.queryByText(/most recent medications/)).toBeNull()
  })

  it('should not auto-fetch on Calendar; its banner offers loading them all', async () => {
    // Arrange
    stubQuietIntersectionObserver()
    arrangePages(3)
    renderApp()
    await awaitFirstPage()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Calendar' }))

    // Assert: partial banner, no fetch beyond the first page.
    expect(
      screen.getByText(/This list is loaded from your 0 most recent medication requests/)
    ).toBeDefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Act: the banner's action drains the rest.
    fireEvent.click(screen.getByRole('button', { name: 'load them all?' }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })
    await waitFor(() => {
      expect(screen.queryByText(/most recent medications/)).toBeNull()
    })
  })

  it('should surface a failed later page on Calendar and recover on retry', async () => {
    // Arrange: page 1 points on, page 2 fails, the retry of page 2 finishes the list.
    stubQuietIntersectionObserver()
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock
      .mockResolvedValueOnce(pageTo(2))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(lastPage)
    renderApp()
    await awaitFirstPage()
    fireEvent.click(screen.getByRole('button', { name: 'Calendar' }))

    // Act: drain the rest — page 2 fails.
    fireEvent.click(screen.getByRole('button', { name: 'load them all?' }))

    // Assert: the failure is surfaced with a retry, not silently swallowed.
    await waitFor(() => {
      expect(screen.getByText(/failed to load/)).toBeDefined()
    })
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined()

    // Act: retry re-requests just that page, which now succeeds.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    // Assert: the list completes and the banner clears.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })
    await waitFor(() => {
      expect(screen.queryByText(/failed to load/)).toBeNull()
    })
  })

  it('should offer a retry when a page fails while streaming partial Interactions', async () => {
    // Arrange: page 2 hangs, then rejects once the user is in partial-stream mode.
    stubQuietIntersectionObserver()
    handshakeMock.mockReturnValue(readyHandshake)
    catalogMock.mockResolvedValue(emptyCatalog)
    let rejectPage2: (error: Error) => void = () => {}
    fetchMock
      .mockResolvedValueOnce(pageTo(2))
      .mockReturnValueOnce(
        new Promise<MedicationRequestPage>((_, reject) => {
          rejectPage2 = reject
        })
      )
      .mockResolvedValueOnce(lastPage)
    renderApp()
    await awaitFirstPage()
    fireEvent.click(screen.getByRole('button', { name: 'Interactions' }))

    // Act: escape the gate into live partial results while page 2 is still in flight.
    await waitFor(() => {
      expect(screen.getByText('Waiting for your full medication list')).toBeDefined()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Show me it live as it loads anyway' }))
    await waitFor(() => {
      expect(screen.getByText(/Partial list — still loading/)).toBeDefined()
    })

    // Act: page 2 fails — the "still loading" claim must not persist.
    act(() => {
      rejectPage2(new Error('boom'))
    })

    // Assert: an error banner with a retry replaces the stuck "still loading" copy.
    await waitFor(() => {
      expect(screen.getByText(/A page of your medication list failed to load/)).toBeDefined()
    })
    expect(screen.queryByText(/still loading/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined()
  })

  it('should auto-load every remaining page on entering Interactions', async () => {
    // Arrange
    stubQuietIntersectionObserver()
    arrangePages(4)
    renderApp()
    await awaitFirstPage()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Interactions' }))

    // Assert: the driver pulls pages 2..4 without further interaction.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(4)
    })
  })

  it('should gate Interactions behind the full list, then stream partial results via the escape', async () => {
    // Arrange: page 2 never resolves, so the list stays incomplete.
    stubQuietIntersectionObserver()
    handshakeMock.mockReturnValue(readyHandshake)
    catalogMock.mockResolvedValue(emptyCatalog)
    fetchMock.mockResolvedValueOnce(pageTo(2)).mockReturnValue(new Promise(() => {}))
    renderApp()
    await awaitFirstPage()

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Interactions' }))

    // Assert: the gate appears (after its anti-flash delay), sections absent.
    await waitFor(() => {
      expect(screen.getByText('Waiting for your full medication list')).toBeDefined()
    })

    // Act: escape into partial-results mode.
    fireEvent.click(screen.getByRole('button', { name: 'Show me it live as it loads anyway' }))

    // Assert
    await waitFor(() => {
      expect(screen.getByText(/Partial list — still loading/)).toBeDefined()
    })
    expect(screen.queryByText('Waiting for your full medication list')).toBeNull()
  })

  it('should show the interaction-checker card when the list is done but the catalog is not', async () => {
    // Arrange
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock.mockResolvedValue(lastPage)
    renderApp()
    await awaitFirstPage()

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Interactions' }))

    // Assert
    expect(screen.getByText('Preparing the interaction checker')).toBeDefined()
  })

  it('should render the chunk bar only from four pages, locked once every page has arrived', async () => {
    // Arrange
    stubQuietIntersectionObserver()
    arrangePages(5)
    renderApp()
    await awaitFirstPage()
    expect(screen.queryByRole('img')).toBeNull() // one page — no bar

    // Act: drain the list via Interactions' auto-start.
    fireEvent.click(screen.getByRole('button', { name: 'Interactions' }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(5)
    })

    // Assert
    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'Your full medication list is loaded' })).toBeDefined()
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
        droppedEntryCount: 0,
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
