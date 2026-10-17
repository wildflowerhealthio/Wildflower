import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vite-plus/test'

import {
  arrangePages,
  atorvastatin,
  awaitFirstPage,
  BASEPATH,
  currentRoute,
  fetchMock,
  handshakeLaunchedWith,
  handshakeMock,
  lastPage,
  launchFailureRedirectMock,
  patientPage,
  patientPageMock,
  readyHandshake,
  setUpEachAppTest,
  stubQuietIntersectionObserver,
  tabLink,
} from './test-utils/app-fakes.ts'
import { renderApp } from './test-utils/render-app.ts'

vi.mock('@wildflowerhealthio/fhir-r4-react/smart', async () =>
  (await import('./test-utils/app-fakes.ts')).smartModuleFake()
)
vi.mock('./routes/interactions/-interaction-catalog.ts', async () =>
  (await import('./test-utils/app-fakes.ts')).interactionCatalogModuleFake()
)

setUpEachAppTest()

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

  it("should read the launch's patient's MedicationRequests, filtered by patient", async () => {
    // Arrange
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock.mockResolvedValue(lastPage)

    // Act
    renderApp()

    // Assert
    await awaitFirstPage()
    expect(fetchMock).toHaveBeenCalledWith({ patientId: 'p1' })
    expect(screen.getByRole('button', { name: 'Change patient' })).toBeDefined()
  })

  it('should offer the patient picker with no patient in context, reading no MedicationRequests', async () => {
    // Arrange
    handshakeMock.mockReturnValue(handshakeLaunchedWith(null))
    patientPageMock.mockResolvedValue(patientPage)

    // Act
    renderApp()

    // Assert
    expect(await screen.findByRole('button', { name: /All patients/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /Ada Lovelace/ })).toBeDefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    { pick: /Ada Lovelace/, patientParam: 'p2', cursor: { patientId: 'p2' } },
    { pick: /All patients/, patientParam: '*', cursor: { patientId: null } },
  ])(
    'should read the MedicationRequests of the choice $patientParam, and write it to the URL',
    async ({ pick, patientParam, cursor }) => {
      // Arrange
      handshakeMock.mockReturnValue(handshakeLaunchedWith(null))
      patientPageMock.mockResolvedValue(patientPage)
      fetchMock.mockResolvedValue(lastPage)
      renderApp()

      // Act
      fireEvent.click(await screen.findByRole('button', { name: pick }))

      // Assert
      await awaitFirstPage()
      expect(fetchMock).toHaveBeenCalledWith(cursor)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(new URLSearchParams(window.location.search).get('patient')).toBe(patientParam)
    }
  )

  it('should go back to the picker on Change patient', async () => {
    // Arrange
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock.mockResolvedValue(lastPage)
    patientPageMock.mockResolvedValue(patientPage)
    renderApp()
    await awaitFirstPage()

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Change patient' }))

    // Assert
    expect(await screen.findByRole('heading', { name: 'Choose a patient' })).toBeDefined()
  })

  it('should keep the tab open when the patient changes', async () => {
    // Arrange
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock.mockResolvedValue(lastPage)
    patientPageMock.mockResolvedValue(patientPage)
    renderApp({ route: 'calendar' })
    await awaitFirstPage()

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Change patient' }))
    fireEvent.click(await screen.findByRole('button', { name: /Ada Lovelace/ }))

    // Assert
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith({ patientId: 'p2' })
    })
    await awaitFirstPage()
    expect(tabLink('Calendar').getAttribute('aria-current')).toBe('page')
    expect(currentRoute()).toBe('calendar')
    expect(new URLSearchParams(window.location.search).get('patient')).toBe('p2')
  })

  it('should keep the chosen patient in the URL across tab changes', async () => {
    // Arrange
    handshakeMock.mockReturnValue(handshakeLaunchedWith(null))
    patientPageMock.mockResolvedValue(patientPage)
    fetchMock.mockResolvedValue(lastPage)
    renderApp()
    fireEvent.click(await screen.findByRole('button', { name: /Ada Lovelace/ }))
    await awaitFirstPage()

    // Act
    fireEvent.click(tabLink('Savings'))

    // Assert
    await waitFor(() => {
      expect(currentRoute()).toBe('savings')
    })
    expect(new URLSearchParams(window.location.search).get('patient')).toBe('p2')
  })

  it('should bring back the patient before, on their tab, on Back through the picker after a patient change', async () => {
    // Arrange: the launch's patient p1 takes atorvastatin; Ada (p2) takes nothing.
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock.mockImplementation((cursor) =>
      Promise.resolve(
        'patientId' in cursor && cursor.patientId === 'p1'
          ? { items: [atorvastatin('mr-1')], nextPageUrl: null, droppedEntryCount: 0 }
          : lastPage
      )
    )
    patientPageMock.mockResolvedValue(patientPage)
    renderApp({ route: 'calendar' })
    await awaitFirstPage()
    fireEvent.click(tabLink('Medications'))
    expect(await screen.findByText(/Atorvastatin/)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Change patient' }))
    fireEvent.click(await screen.findByRole('button', { name: /Ada Lovelace/ }))
    expect(await screen.findByText('No medications found.')).toBeDefined()
    expect(new URLSearchParams(window.location.search).get('patient')).toBe('p2')

    // Act: Back to the picker's entry, then past it.
    window.history.back()
    expect(await screen.findByRole('heading', { name: 'Choose a patient' })).toBeDefined()
    window.history.back()

    // Assert: the entry before names no patient, so the launch's, as it showed.
    expect(await screen.findByText(/Atorvastatin/)).toBeDefined()
    expect(currentRoute()).toBe('medications')
    expect(window.location.search).toBe('')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('should close the picker on Back, on the page it was opened over, and reopen it on Forward', async () => {
    // Arrange: Ada (p2) chosen over the launch's p1, then the picker opened.
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock.mockResolvedValue(lastPage)
    patientPageMock.mockResolvedValue(patientPage)
    renderApp({ route: 'calendar' })
    await awaitFirstPage()
    fireEvent.click(screen.getByRole('button', { name: 'Change patient' }))
    fireEvent.click(await screen.findByRole('button', { name: /Ada Lovelace/ }))
    await awaitFirstPage()
    fireEvent.click(screen.getByRole('button', { name: 'Change patient' }))
    expect(await screen.findByRole('heading', { name: 'Choose a patient' })).toBeDefined()
    expect(new URLSearchParams(window.location.search).get('patient')).toBe('p2')

    // Act
    window.history.back()

    // Assert: Ada's page, on the tab the picker was opened over.
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Choose a patient' })).toBeNull()
    })
    await awaitFirstPage()
    expect(currentRoute()).toBe('calendar')
    expect(window.location.search).toBe('?patient=p2')

    // Act: Forward, to the picker's entry.
    window.history.forward()

    // Assert
    expect(await screen.findByRole('heading', { name: 'Choose a patient' })).toBeDefined()
  })

  it('should read the patient a numeric `?patient=` names, keeping it as written across tabs', async () => {
    // Arrange
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock.mockResolvedValue(lastPage)
    renderApp({ route: 'medications?patient=123' })
    await awaitFirstPage()

    // Act
    fireEvent.click(tabLink('Savings'))

    // Assert
    await waitFor(() => {
      expect(currentRoute()).toBe('savings')
    })
    expect(fetchMock).toHaveBeenCalledWith({ patientId: '123' })
    expect(window.location.search).toBe('?patient=123')
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

  it('should leave the callback URL alone until the handshake completes, then open Medications', async () => {
    // Arrange: the OAuth callback, its code and state still to be exchanged.
    handshakeMock.mockReturnValue({ kind: 'connecting' })
    fetchMock.mockResolvedValue(lastPage)
    const callback = `${BASEPATH}?code=abc&state=xyz`
    const { rerenderApp } = renderApp({ route: '?code=abc&state=xyz' })

    // Assert: nothing routes while the exchange reads the URL.
    expect(`${window.location.pathname}${window.location.search}`).toBe(callback)

    // Act: the exchange completes, fhirclient having taken code and state out
    // of the address bar, as it does.
    window.history.replaceState(window.history.state, '', BASEPATH)
    handshakeMock.mockReturnValue(readyHandshake)
    rerenderApp()

    // Assert
    await awaitFirstPage()
    await waitFor(() => {
      expect(currentRoute()).toBe('medications')
    })
    expect(window.location.search).toBe('')
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

  it('should offer all four tabs and open Medications, replacing the bare path', async () => {
    // Arrange
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock.mockResolvedValue(lastPage)
    const historyLength = window.history.length

    // Act
    renderApp()

    // Assert
    await awaitFirstPage()
    for (const label of ['Medications', 'Calendar', 'Interactions', 'Savings']) {
      expect(tabLink(label)).toBeDefined()
    }
    await waitFor(() => {
      expect(tabLink('Medications').getAttribute('aria-current')).toBe('page')
    })
    expect(currentRoute()).toBe('medications')
    expect(window.history.length).toBe(historyLength)
    expect(screen.queryByRole('combobox', { name: 'Province' })).toBeNull()
    expect(await screen.findByText('No medications found.')).toBeDefined()
  })

  it('should say a path no tab names has no page, offering the list for the same patient', async () => {
    // Arrange
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock.mockResolvedValue(lastPage)
    renderApp({ route: 'index.html?patient=p2' })
    await awaitFirstPage()
    expect(
      await screen.findByText('The Medication Viewer has no page at /index.html.')
    ).toBeDefined()

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Open the medications list' }))

    // Assert
    expect(await screen.findByText('No medications found.')).toBeDefined()
    expect(currentRoute()).toBe('medications')
    expect(fetchMock).toHaveBeenCalledWith({ patientId: 'p2' })
    expect(new URLSearchParams(window.location.search).get('patient')).toBe('p2')
  })

  it('should render the chunk bar only from four pages, locked once every page has arrived', async () => {
    // Arrange
    stubQuietIntersectionObserver()
    arrangePages(5)
    renderApp()
    await awaitFirstPage()
    expect(screen.queryByRole('img')).toBeNull() // one page — no bar

    // Act: drain the list via Interactions' auto-start.
    fireEvent.click(tabLink('Interactions'))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(5)
    })

    // Assert
    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'Your full medication list is loaded' })).toBeDefined()
    })
  })
})
