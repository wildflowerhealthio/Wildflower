import { QueryClient } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  isNotFound,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import type { SmartClient } from '@wildflowerhealthio/fhir-r4-react/smart'
import { Option } from 'effect'
import type { JSX } from 'react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { patientChoiceKeyOf } from './patient-choice.ts'
import {
  ensureRoutedPatient,
  launchPatientRoute,
  missingPatientIdOf,
  useRoutedPatientChoice,
} from './routed-patient-choice.ts'
import { answer, stubSmartClient } from './smart-client.test-helpers.ts'

afterEach(() => {
  cleanup()
})

/** A client whose launch put `patientId` in context; only `patient.id` is read. */
const launchedWith = (patientId: string | null): SmartClient =>
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test-only stub: only `patient.id` is read
  ({ patient: { id: patientId } }) as unknown as SmartClient

describe('launchPatientRoute', () => {
  it('should open the launch’s patient', () => {
    expect(launchPatientRoute(launchedWith('1.50'))).toBe('/patients/1.50')
  })

  it('should open the picker for a launch with no patient', () => {
    expect(launchPatientRoute(launchedWith(null))).toBe('/patients')
  })
})

/** A route's page, naming the choice the hook reads there. */
function ChoiceLine(): JSX.Element {
  return <p>{patientChoiceKeyOf(useRoutedPatientChoice())}</p>
}

/** Render a router at `url`, with `/patients/$patientId/tab` and an all-patients `/tab`. */
const renderAt = (url: string): void => {
  const rootRoute = createRootRoute()
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: '/tab', component: ChoiceLine }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: '/patients/$patientId/tab',
        component: ChoiceLine,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: [url] }),
  })
  render(<RouterProvider router={router} />)
}

describe('useRoutedPatientChoice', () => {
  it.each([
    { case: 'the patient the path names', url: '/patients/p2/tab', key: 'p2' },
    { case: 'a numeric-looking id as written', url: '/patients/1.50/tab', key: '1.50' },
    { case: 'every patient on a route naming none', url: '/tab', key: '*' },
  ])('should read $case', async ({ url, key }) => {
    // Act
    renderAt(url)

    // Assert
    expect(await screen.findByText(key)).toBeDefined()
  })
})

describe('missingPatientIdOf', () => {
  it('should read nothing for a path no route matched', () => {
    expect(missingPatientIdOf(undefined)).toStrictEqual(Option.none())
  })
})

describe('ensureRoutedPatient', () => {
  /** A retry-free cache, so a failed read settles at once. */
  const testQueryClient = (): QueryClient =>
    new QueryClient({ defaultOptions: { queries: { retry: false } } })

  it('should load the patient into the cache the patient line reads', async () => {
    // Arrange
    const queryClient = testQueryClient()
    const { client } = stubSmartClient({
      'Patient/p1': answer({ resourceType: 'Patient', id: 'p1' }),
    })

    // Act
    await ensureRoutedPatient(queryClient, client, 'p1')

    // Assert
    expect(queryClient.getQueryData(['patient', 'p1'])).toMatchObject({ kind: 'found' })
  })

  it.each([404, 410])('should throw not-found naming the patient on a %i', async (status) => {
    // Arrange
    const { client } = stubSmartClient({
      'Patient/bogus': () => Promise.reject(Object.assign(new Error('gone'), { status })),
    })

    // Act
    const thrown: unknown = await ensureRoutedPatient(testQueryClient(), client, 'bogus').then(
      () => null,
      (error: unknown) => error
    )

    // Assert
    expect(isNotFound(thrown)).toBe(true)
    expect(missingPatientIdOf(isNotFound(thrown) ? thrown.data : undefined)).toStrictEqual(
      Option.some('bogus')
    )
  })

  it('should let the route render on any other failure', async () => {
    // Arrange
    const { client } = stubSmartClient({
      'Patient/p1': () => Promise.reject(Object.assign(new Error('down'), { status: 503 })),
    })

    // Act / Assert
    await expect(ensureRoutedPatient(testQueryClient(), client, 'p1')).resolves.toBeUndefined()
  })
})
