import { act, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vite-plus/test'

import {
  atorvastatin,
  awaitFirstPage,
  fetchMock,
  handshakeMock,
  lastPage,
  readyHandshake,
  setUpEachAppTest,
} from '../../test-utils/app-fakes.ts'
import { renderApp } from '../../test-utils/render-app.ts'

vi.mock('@wildflowerhealthio/fhir-r4-react/smart', async () =>
  (await import('../../test-utils/app-fakes.ts')).smartModuleFake()
)
vi.mock('../interactions/-interaction-catalog.ts', async () =>
  (await import('../../test-utils/app-fakes.ts')).interactionCatalogModuleFake()
)

setUpEachAppTest()

describe('Medications tab', () => {
  it('should open Medications at /medications', async () => {
    // Arrange
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock.mockResolvedValue(lastPage)

    // Act
    renderApp({ route: 'medications' })

    // Assert
    await awaitFirstPage()
    expect(await screen.findByText('No medications found.')).toBeDefined()
  })

  it('should render one row per request, keyed by its server id', async () => {
    // Arrange: two same-named requests, told apart only by their ids.
    const consoleError = vi.spyOn(console, 'error')
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock.mockResolvedValue({
      items: [atorvastatin('mr-1'), atorvastatin('mr-2')],
      nextPageUrl: null,
      droppedEntryCount: 0,
    })

    // Act
    renderApp()

    // Assert: both rows render, and React reports no duplicate key.
    await awaitFirstPage()
    expect(await screen.findAllByText('Atorvastatin 20 mg tablet')).toHaveLength(2)
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
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
