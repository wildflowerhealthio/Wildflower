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
  MISSING_PATIENT_ID,
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
vi.mock('./routes/-tabs/interactions/-interaction-catalog.ts', async () =>
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

  it("should open the launch's patient's page, in the app root's place, reading their MedicationRequests", async () => {
    // Arrange
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock.mockResolvedValue(lastPage)
    const historyLength = window.history.length

    // Act
    renderApp()

    // Assert
    await awaitFirstPage()
    expect(fetchMock).toHaveBeenCalledWith({ patientId: 'p1' })
    expect(screen.getByRole('button', { name: 'Change patient' })).toBeDefined()
    expect(currentRoute()).toBe('patients/p1/medications')
    expect(window.history.length).toBe(historyLength)
  })

  it('should open the patient picker with no patient in context, reading no MedicationRequests', async () => {
    // Arrange
    handshakeMock.mockReturnValue(handshakeLaunchedWith(null))
    patientPageMock.mockResolvedValue(patientPage)

    // Act
    renderApp()

    // Assert
    expect(await screen.findByRole('button', { name: /All patients/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /Ada Lovelace/ })).toBeDefined()
    expect(currentRoute()).toBe('patients')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    { pick: /Ada Lovelace/, route: 'patients/p2/medications', cursor: { patientId: 'p2' } },
    { pick: /All patients/, route: 'medications', cursor: { patientId: null } },
  ])(
    'should read the MedicationRequests of the choice, at $route',
    async ({ pick, route, cursor }) => {
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
      await waitFor(() => {
        expect(currentRoute()).toBe(route)
      })
    }
  )

  it('should link every patient’s tabs at the top level', async () => {
    // Arrange
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock.mockResolvedValue(lastPage)

    // Act
    renderApp({ route: 'calendar' })

    // Assert
    await awaitFirstPage()
    expect(screen.getByText('All patients')).toBeDefined()
    expect(fetchMock).toHaveBeenCalledWith({ patientId: null })
    expect(tabLink('Savings').getAttribute('href')).toBe(`${BASEPATH}savings`)
  })

  it('should push the picker on Change patient, closing it on Back over the tab open and reopening it on Forward', async () => {
    // Arrange
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock.mockResolvedValue(lastPage)
    patientPageMock.mockResolvedValue(patientPage)
    renderApp({ route: 'patients/p1/calendar' })
    await awaitFirstPage()

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Change patient' }))

    // Assert
    expect(await screen.findByRole('heading', { name: 'Choose a patient' })).toBeDefined()
    expect(currentRoute()).toBe('patients')

    // Act
    window.history.back()

    // Assert
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Choose a patient' })).toBeNull()
    })
    await awaitFirstPage()
    expect(currentRoute()).toBe('patients/p1/calendar')

    // Act
    window.history.forward()

    // Assert
    expect(await screen.findByRole('heading', { name: 'Choose a patient' })).toBeDefined()
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
    renderApp({ route: 'patients/p1/calendar' })
    await awaitFirstPage()
    fireEvent.click(tabLink('Medications'))
    expect(await screen.findByText(/Atorvastatin/)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Change patient' }))
    fireEvent.click(await screen.findByRole('button', { name: /Ada Lovelace/ }))
    expect(await screen.findByText('No medications found.')).toBeDefined()
    expect(currentRoute()).toBe('patients/p2/medications')

    // Act: Back to the picker's entry, then past it.
    window.history.back()
    expect(await screen.findByRole('heading', { name: 'Choose a patient' })).toBeDefined()
    window.history.back()

    // Assert: p1's page, on the tab it showed, read from the cache.
    expect(await screen.findByText(/Atorvastatin/)).toBeDefined()
    expect(currentRoute()).toBe('patients/p1/medications')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('should read a numeric-looking patient id in the path as the id it is', async () => {
    // Arrange — `1.50` would read as the number 1.5 under a JSON parser
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock.mockResolvedValue(lastPage)
    renderApp({ route: 'patients/1.50/medications' })
    await awaitFirstPage()

    // Act
    fireEvent.click(tabLink('Savings'))

    // Assert
    await waitFor(() => {
      expect(currentRoute()).toBe('patients/1.50/savings')
    })
    expect(fetchMock).toHaveBeenCalledWith({ patientId: '1.50' })
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

  it('should leave the callback URL alone until the handshake completes, then open the launch’s patient', async () => {
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
      expect(currentRoute()).toBe('patients/p1/medications')
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
    renderApp({ route: 'patients/p1' })

    // Assert
    await awaitFirstPage()
    for (const label of ['Medications', 'Calendar', 'Interactions', 'Savings']) {
      expect(tabLink(label)).toBeDefined()
    }
    await waitFor(() => {
      expect(tabLink('Medications').getAttribute('aria-current')).toBe('page')
    })
    expect(currentRoute()).toBe('patients/p1/medications')
    expect(window.history.length).toBe(historyLength)
    expect(screen.queryByRole('combobox', { name: 'Province' })).toBeNull()
    expect(await screen.findByText('No medications found.')).toBeDefined()
  })

  it.each([
    { case: 'a path no route names', route: 'index.html', pathname: '/index.html' },
    {
      case: 'every patient’s interactions, between different people’s medications',
      route: 'interactions',
      pathname: '/interactions',
    },
    {
      case: 'a path under a patient no tab names',
      route: 'patients/p1/nowhere',
      pathname: '/patients/p1/nowhere',
    },
  ])('should say $case has no page, offering the picker', async ({ route, pathname }) => {
    // Arrange
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock.mockResolvedValue(lastPage)
    patientPageMock.mockResolvedValue(patientPage)
    renderApp({ route })
    expect(await screen.findByText(`There's no page at ${pathname}.`)).toBeDefined()

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Choose a patient' }))

    // Assert
    expect(await screen.findByRole('heading', { name: 'Choose a patient' })).toBeDefined()
    expect(currentRoute()).toBe('patients')
  })

  it('should say the server has no patient for an id it does not hold, reading nothing of theirs', async () => {
    // Arrange
    handshakeMock.mockReturnValue(readyHandshake)

    // Act
    renderApp({ route: `patients/${MISSING_PATIENT_ID}/calendar` })

    // Assert
    expect(
      await screen.findByText(`This server has no patient ${MISSING_PATIENT_ID}.`)
    ).toBeDefined()
    expect(screen.queryByRole('navigation', { name: 'Medication views' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
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
