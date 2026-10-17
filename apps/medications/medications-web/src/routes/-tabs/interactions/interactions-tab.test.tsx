import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import type { MedicationRequestPage } from '@wildflowerhealthio/fhir-r4-react/smart'
import { describe, expect, it, vi } from 'vite-plus/test'

import {
  arrangePages,
  awaitFirstPage,
  catalogMock,
  emptyCatalog,
  fetchMock,
  handshakeMock,
  lastPage,
  pageTo,
  readyHandshake,
  setUpEachAppTest,
  stubQuietIntersectionObserver,
  tabLink,
} from '../../../test-utils/app-fakes.ts'
import { renderApp } from '../../../test-utils/render-app.ts'

vi.mock('@wildflowerhealthio/fhir-r4-react/smart', async () =>
  (await import('../../../test-utils/app-fakes.ts')).smartModuleFake()
)
vi.mock('./-interaction-catalog.ts', async () =>
  (await import('../../../test-utils/app-fakes.ts')).interactionCatalogModuleFake()
)

setUpEachAppTest()

describe('Interactions tab', () => {
  it('should load every remaining page on entering Interactions', async () => {
    // Arrange
    stubQuietIntersectionObserver()
    arrangePages(4)
    renderApp()
    await awaitFirstPage()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Act
    fireEvent.click(tabLink('Interactions'))

    // Assert: the driver pulls pages 2..4 without further interaction.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(4)
    })
  })

  it("should load every page when opened straight from a link to a patient's interactions", async () => {
    // Arrange
    stubQuietIntersectionObserver()
    arrangePages(4)

    // Act
    renderApp({ route: 'patients/p1/interactions' })

    // Assert: the driver pulls pages 2..4, and the tab is the one open.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(4)
    })
    expect(tabLink('Interactions').getAttribute('aria-current')).toBe('page')
  })

  it('should start the interaction catalog on entry, before the first medication page lands', async () => {
    // Arrange: the first page never lands.
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock.mockReturnValue(new Promise(() => {}))

    // Act
    renderApp({ route: 'patients/p1/interactions' })

    // Assert: both downloads are in flight, the tab not yet rendered.
    await waitFor(() => {
      expect(catalogMock).toHaveBeenCalledTimes(1)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Loading medications…')).toBeDefined()
  })

  it('should keep loading every page after leaving Interactions', async () => {
    // Arrange: page 2 hangs until the reader has left the tab.
    stubQuietIntersectionObserver()
    handshakeMock.mockReturnValue(readyHandshake)
    let resolvePage2: (page: MedicationRequestPage) => void = () => {}
    fetchMock
      .mockResolvedValueOnce(pageTo(2))
      .mockReturnValueOnce(
        new Promise<MedicationRequestPage>((resolve) => {
          resolvePage2 = resolve
        })
      )
      .mockResolvedValueOnce(lastPage)
    renderApp({ route: 'patients/p1/interactions' })
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    // Act
    fireEvent.click(tabLink('Calendar'))
    await screen.findByRole('button', { name: 'Next month' })
    act(() => {
      resolvePage2(pageTo(3))
    })

    // Assert
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3)
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
    fireEvent.click(tabLink('Interactions'))

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

  it('should offer a retry when a page fails while streaming partial results', async () => {
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
    renderApp({ route: 'patients/p1/interactions' })
    await awaitFirstPage()

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

  it('should show the interaction-checker card when the list is done but the catalog is not', async () => {
    // Arrange
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock.mockResolvedValue(lastPage)
    renderApp()
    await awaitFirstPage()

    // Act
    fireEvent.click(tabLink('Interactions'))

    // Assert
    expect(await screen.findByText('Preparing the interaction checker')).toBeDefined()
  })

  it('should not fetch the interaction catalog before Interactions opens', async () => {
    // Arrange
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock.mockResolvedValue(lastPage)

    // Act
    renderApp({ route: 'patients/p1/calendar' })
    await awaitFirstPage()

    // Assert
    expect(catalogMock).not.toHaveBeenCalled()
  })
})
