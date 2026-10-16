import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vite-plus/test'

import {
  arrangePages,
  awaitFirstPage,
  currentRoute,
  fetchMock,
  handshakeMock,
  lastPage,
  pageTo,
  readyHandshake,
  setUpEachAppTest,
  stubQuietIntersectionObserver,
  tabLink,
} from '../../test-utils/app-fakes.ts'
import { renderApp } from '../../test-utils/render-app.ts'

vi.mock('@wildflowerhealthio/fhir-r4-react/smart', async () =>
  (await import('../../test-utils/app-fakes.ts')).smartModuleFake()
)
vi.mock('../interactions/-interaction-catalog.ts', async () =>
  (await import('../../test-utils/app-fakes.ts')).interactionCatalogModuleFake()
)

setUpEachAppTest()

describe('Calendar tab', () => {
  it('should open Calendar at /calendar', async () => {
    // Arrange
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock.mockResolvedValue(lastPage)

    // Act
    renderApp({ route: 'calendar' })

    // Assert
    await awaitFirstPage()
    expect(await screen.findByRole('button', { name: 'Next month' })).toBeDefined()
    expect(tabLink('Calendar').getAttribute('aria-current')).toBe('page')
    expect(currentRoute()).toBe('calendar')
  })

  it('should show the month grid without any partial banner once loaded', async () => {
    // Arrange
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock.mockResolvedValue(lastPage)
    renderApp()
    await awaitFirstPage()

    // Act
    fireEvent.click(tabLink('Calendar'))

    // Assert
    expect(await screen.findByRole('button', { name: 'Next month' })).toBeDefined()
    expect(currentRoute()).toBe('calendar')
    expect(screen.queryByText(/most recent medication requests/)).toBeNull()
  })

  it('should not auto-fetch; its banner offers loading them all', async () => {
    // Arrange
    stubQuietIntersectionObserver()
    arrangePages(3)
    renderApp()
    await awaitFirstPage()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Act
    fireEvent.click(tabLink('Calendar'))

    // Assert: partial banner, no fetch beyond the first page.
    expect(
      await screen.findByText(/This list is loaded from your 0 most recent medication requests/)
    ).toBeDefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Act: the banner's action drains the rest.
    fireEvent.click(screen.getByRole('button', { name: 'load them all?' }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })
    await waitFor(() => {
      expect(screen.queryByText(/most recent medication requests/)).toBeNull()
    })
  })

  it('should surface a failed later page and recover on retry', async () => {
    // Arrange: page 1 points on, page 2 fails, the retry of page 2 finishes the list.
    stubQuietIntersectionObserver()
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock
      .mockResolvedValueOnce(pageTo(2))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(lastPage)
    renderApp({ route: 'calendar' })
    await awaitFirstPage()

    // Act: drain the rest — page 2 fails.
    fireEvent.click(await screen.findByRole('button', { name: 'load them all?' }))

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
})
