import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import { STRENGTH_SCOPE } from '../config.ts'
import {
  type FakeFhirServer,
  resourceTypeOfQuery,
  resourceTypeOfWire,
  searchParamsOf,
} from '../fake-fhir-server.test-helpers.ts'
import {
  BASEPATH,
  currentRoute,
  END_TO_END_TIMEOUT_MILLIS,
  endStrengthTest,
  mountStrengthApp,
  PATIENT_ID,
  seedStartedLifter,
  seedWorkout,
  startStrengthTest,
  tabLink,
  tapEverySet,
} from '../strength-app.test-helpers.ts'

/**
 * The lifting page, every tab, driven through the app's router over the
 * in-memory FHIR server (see `strength-app.test-helpers.ts`).
 */

let server: FakeFhirServer

beforeEach(() => {
  server = startStrengthTest()
})

afterEach(endStrengthTest)

describe('StrengthPage', { timeout: END_TO_END_TIMEOUT_MILLIS }, () => {
  it('should search and write only the resource types its requested scopes grant', async () => {
    // Arrange — a start, a workout and the history: every read and write the app makes
    const user = userEvent.setup()
    mountStrengthApp(server)
    await user.click(await screen.findByRole('button', { name: 'Start program' }))
    await screen.findByRole('heading', { name: 'Workout A' })
    await tapEverySet(user, 'Squat', 5)
    await user.click(screen.getByRole('button', { name: 'Submit workout' }))
    await user.click(await screen.findByRole('button', { name: 'Next workout' }))
    await user.click(tabLink('History'))
    await screen.findByText(/^Workout A · /)

    // Assert
    const searchedTypes = new Set(server.searches.map(resourceTypeOfQuery))
    const readTypes = new Set(server.reads.map((reference) => reference.split('/')[0] ?? ''))
    const writtenTypes = new Set(server.writes.flat().map(resourceTypeOfWire))
    expect([...searchedTypes].toSorted()).toEqual(
      ['Observation', 'PlanDefinition', 'Procedure', 'ServiceRequest'].toSorted()
    )
    expect([...readTypes]).toEqual(['Patient'])
    for (const resourceType of searchedTypes) expect(grantedTypes('s')).toContain(resourceType)
    for (const resourceType of readTypes) expect(grantedTypes('r')).toContain(resourceType)
    for (const resourceType of writtenTypes) {
      expect(grantedTypes('c')).toContain(resourceType)
      expect(grantedTypes('u')).toContain(resourceType)
    }
  })

  it.each([
    { case: 'a lifter', route: '', tab: 'today' },
    { case: 'All patients', route: '?patient=*', tab: 'history' },
  ] as const)(
    'should open the bare app path on $tab for $case, in its place in history',
    async ({ route, tab }) => {
      // Arrange
      seedStartedLifter(server)
      const historyLength = window.history.length

      // Act
      mountStrengthApp(server, { route })

      // Assert
      await waitFor(() => {
        expect(currentRoute()).toBe(tab)
      })
      expect(window.history.length).toBe(historyLength)
      expect(tabLink(tab === 'today' ? 'Today' : 'History').getAttribute('aria-current')).toBe(
        'page'
      )
    }
  )

  it('should keep the chosen patient in the address bar across tabs', async () => {
    // Arrange
    const user = userEvent.setup()
    seedStartedLifter(server)
    mountStrengthApp(server, { route: `?patient=${PATIENT_ID}` })
    await screen.findByRole('heading', { name: 'Workout A' })

    // Act
    await user.click(tabLink('History'))

    // Assert
    await waitFor(() => {
      expect(currentRoute()).toBe('history')
    })
    expect(new URLSearchParams(window.location.search).get('patient')).toBe(PATIENT_ID)
  })

  it('should read a numeric-looking ?patient= as the id it is, and keep it across tabs', async () => {
    // Arrange — `1.50` reads as the number 1.5 under a JSON search parser
    const user = userEvent.setup()
    mountStrengthApp(server, { launchPatientId: null, route: 'today?patient=1.50' })
    await screen.findByRole('button', { name: 'Start program' })

    // Act
    await user.click(tabLink('History'))

    // Assert — every scoped search named `1.50`, and the address bar still does
    await waitFor(() => {
      expect(currentRoute()).toBe('history')
    })
    expect(window.location.search).toBe('?patient=1.50')
    const scopedPatients = new Set(
      server.searches.flatMap((query) => searchParamsOf(query).getAll('patient'))
    )
    expect([...scopedPatients]).toEqual(['1.50'])
  })

  it('should keep only ?patient= on the tab links', async () => {
    // Act
    mountStrengthApp(server, { route: `today?patient=${PATIENT_ID}&stray=1` })

    // Assert
    await screen.findByRole('button', { name: 'Start program' })
    expect(tabLink('History').getAttribute('href')).toBe(`${BASEPATH}history?patient=${PATIENT_ID}`)
  })

  it('should show the not-found card for a path no tab names, opening the first tab from it', async () => {
    // Arrange
    const user = userEvent.setup()
    mountStrengthApp(server, { route: 'nowhere' })
    expect(await screen.findByText('Strength has no page at /nowhere.')).toBeDefined()

    // Act
    await user.click(screen.getByRole('button', { name: 'Open Strength' }))

    // Assert
    await waitFor(() => {
      expect(currentRoute()).toBe('today')
    })
    expect(screen.queryByText('Strength has no page at /nowhere.')).toBeNull()
  })

  it('should name the lifter under the title', async () => {
    // Act
    mountStrengthApp(server)

    // Assert
    expect(await screen.findByText('Ada Lovelace · born 1990-01-01')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Change patient' })).toBeDefined()
  })

  it("should open All patients on every patient's history, read unscoped, writing nothing", async () => {
    // Arrange
    seedStartedLifter(server)
    seedWorkout(server, { squat: [5, 5, 5, 5, 5], 'bench-press': [5, 5, 5, 5, 5] })

    // Act
    mountStrengthApp(server, { route: '?patient=*' })

    // Assert — the history is listed, and no search named a patient
    expect(await screen.findByText(/^Workout A · /)).toBeDefined()
    expect(screen.getByText('All patients')).toBeDefined()
    expect(server.searches).not.toHaveLength(0)
    expect(server.searches.every((query) => !searchParamsOf(query).has('patient'))).toBe(true)
    expect(server.writes).toEqual([])
  })

  it.each(['Today', 'Plan'])(
    'should ask for a patient on %s with All patients, offering no control that writes',
    async (tabLabel) => {
      // Arrange
      const user = userEvent.setup()
      seedStartedLifter(server)
      mountStrengthApp(server, { route: '?patient=*' })

      // Act
      await user.click(await screen.findByRole('link', { name: tabLabel }))

      // Assert
      expect(screen.getByText('Choose a patient to train')).toBeDefined()
      expect(screen.getByRole('button', { name: 'Choose a patient' })).toBeDefined()
      expect(screen.queryByRole('button', { name: 'Start program' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Submit workout' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
      expect(server.writes).toEqual([])
    }
  )

  it('should open the patient picker from Today’s card with All patients, closing it on Back', async () => {
    // Arrange
    const user = userEvent.setup()
    mountStrengthApp(server, { route: 'today?patient=*' })

    // Act
    await user.click(await screen.findByRole('button', { name: 'Choose a patient' }))

    // Assert — the picker's own entry, over the same tab and patient
    expect(await screen.findByRole('heading', { name: 'Choose a patient' })).toBeDefined()
    expect(currentRoute()).toBe('today')
    expect(new URLSearchParams(window.location.search).get('patient')).toBe('*')

    // Act
    window.history.back()

    // Assert
    expect(await screen.findByText('Choose a patient to train')).toBeDefined()
    expect(screen.queryByRole('heading', { name: 'Choose a patient' })).toBeNull()
    expect(window.location.search).toBe('?patient=*')
  })
})

/**
 * The resource types `STRENGTH_SCOPE` grants `permission` on (a SMART v2
 * letter: `s` search, `c` create, `u` update), read off the string itself.
 */
const grantedTypes = (permission: string): readonly string[] =>
  STRENGTH_SCOPE.split(' ').flatMap((scope) => {
    const [, resourceType, permissions] = /^system\/(\w+)\.([cruds]+)$/.exec(scope) ?? []
    return resourceType !== undefined && permissions?.includes(permission) ? [resourceType] : []
  })
