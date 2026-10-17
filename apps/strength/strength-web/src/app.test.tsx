import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type * as FhirR4ReactSmart from '@wildflowerhealthio/fhir-r4-react/smart'
import type { SmartHandshake } from '@wildflowerhealthio/fhir-r4-react/smart'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { type FakeFhirServer, resourceTypeOfQuery } from './fake-fhir-server.test-helpers.ts'
import type * as RouterModule from './router.ts'
import {
  BASEPATH,
  currentRoute,
  END_TO_END_TIMEOUT_MILLIS,
  endStrengthTest,
  openTestPage,
  PATIENT_ID,
  renderWithQueryClient,
  seedStartedLifter,
  startStrengthTest,
  tabLink,
} from './strength-app.test-helpers.ts'

const { handshakeMock } = vi.hoisted(() => ({
  handshakeMock: vi.fn<() => SmartHandshake>(),
}))
vi.mock('@wildflowerhealthio/fhir-r4-react/smart', async (importOriginal) => ({
  ...(await importOriginal<typeof FhirR4ReactSmart>()),
  useSmartHandshake: () => handshakeMock(),
  useLaunchFailureRedirect: (): void => undefined,
}))

// The router builder, spied on, so a test can tell the router outlives a
// patient change.
vi.mock('./router.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof RouterModule>()
  return { buildRouter: vi.fn(actual.buildRouter) }
})

const { App } = await import('./app.tsx')
const { buildRouter } = await import('./router.ts')

/**
 * `App`: the patient chosen — the URL's, the launch's, or the picker's —
 * decides what mounts, over the in-memory FHIR server (see
 * `strength-app.test-helpers.ts`). The SMART handshake (which needs a browser
 * redirect) and `useLaunchFailureRedirect` (which would navigate away) are
 * stubbed.
 */

let server: FakeFhirServer

beforeEach(() => {
  server = startStrengthTest()
  window.history.replaceState(null, '', BASEPATH)
})

afterEach(() => {
  endStrengthTest()
  handshakeMock.mockReset()
  vi.mocked(buildRouter).mockClear()
})

describe('App', { timeout: END_TO_END_TIMEOUT_MILLIS }, () => {
  it('should offer the patient picker when the launch names no patient, reading no record', async () => {
    // Arrange
    handshakeMock.mockReturnValue({ kind: 'ready', client: server.clientFor(null) })

    // Act
    renderWithQueryClient(<App page={openTestPage()} />)

    // Assert — only patients are searched
    expect(await screen.findByRole('button', { name: /Ada Lovelace/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /All patients/ })).toBeDefined()
    expect(server.searches.map(resourceTypeOfQuery)).toEqual(['Patient'])
    expect(server.writes).toEqual([])
  })

  it('should mount the lifting screens for the patient picked, and write the pick to the URL', async () => {
    // Arrange
    const user = userEvent.setup()
    seedStartedLifter(server)
    handshakeMock.mockReturnValue({ kind: 'ready', client: server.clientFor(null) })
    renderWithQueryClient(<App page={openTestPage()} />)

    // Act
    await user.click(await screen.findByRole('button', { name: /Ada Lovelace/ }))

    // Assert
    expect(await screen.findByRole('heading', { name: 'Workout A' })).toBeDefined()
    expect(new URLSearchParams(window.location.search).get('patient')).toBe(PATIENT_ID)
  })

  it('should go back to the picker on Change patient', async () => {
    // Arrange
    const user = userEvent.setup()
    seedStartedLifter(server)
    handshakeMock.mockReturnValue({ kind: 'ready', client: server.clientFor(PATIENT_ID) })
    renderWithQueryClient(<App page={openTestPage()} />)
    await screen.findByRole('heading', { name: 'Workout A' })

    // Act
    await user.click(screen.getByRole('button', { name: 'Change patient' }))

    // Assert
    expect(await screen.findByRole('heading', { name: 'Choose a patient' })).toBeDefined()
  })

  it('should open History on a change to All patients from Today, in the same router', async () => {
    // Arrange
    const user = userEvent.setup()
    seedStartedLifter(server)
    handshakeMock.mockReturnValue({ kind: 'ready', client: server.clientFor(PATIENT_ID) })
    renderWithQueryClient(<App page={openTestPage()} />)
    await screen.findByRole('heading', { name: 'Workout A' })
    const routersBuilt = vi.mocked(buildRouter).mock.calls.length

    // Act
    await user.click(screen.getByRole('button', { name: 'Change patient' }))
    await user.click(await screen.findByRole('button', { name: /All patients/ }))

    // Assert — History, not Today's "Choose a patient" card, and no new router
    await waitFor(() => {
      expect(currentRoute()).toBe('history')
    })
    expect(new URLSearchParams(window.location.search).get('patient')).toBe('*')
    expect(tabLink('History').getAttribute('aria-current')).toBe('page')
    expect(screen.queryByText('Choose a patient to train')).toBeNull()
    expect(vi.mocked(buildRouter).mock.calls).toHaveLength(routersBuilt)
  })

  it('should return to the lifter’s Today on Back from a patient change', async () => {
    // Arrange
    const user = userEvent.setup()
    seedStartedLifter(server)
    handshakeMock.mockReturnValue({ kind: 'ready', client: server.clientFor(PATIENT_ID) })
    renderWithQueryClient(<App page={openTestPage()} />)
    await screen.findByRole('heading', { name: 'Workout A' })
    await user.click(screen.getByRole('button', { name: 'Change patient' }))
    await user.click(await screen.findByRole('button', { name: /All patients/ }))
    await waitFor(() => {
      expect(currentRoute()).toBe('history')
    })

    // Act
    window.history.back()

    // Assert
    expect(await screen.findByRole('heading', { name: 'Workout A' })).toBeDefined()
    expect(currentRoute()).toBe('today')
    expect(screen.getByText('Ada Lovelace · born 1990-01-01')).toBeDefined()
  })

  it('should mount the lifting screens for the patient the launch names', async () => {
    // Arrange
    seedStartedLifter(server)
    handshakeMock.mockReturnValue({ kind: 'ready', client: server.clientFor(PATIENT_ID) })

    // Act
    renderWithQueryClient(<App page={openTestPage()} />)

    // Assert
    expect(await screen.findByRole('heading', { name: 'Workout A' })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Wildflower Strength', level: 1 })).toBeDefined()
  })
})
