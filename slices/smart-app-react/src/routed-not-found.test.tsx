import { QueryClient } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { PatientRouteNotFound, RouteNotFound } from './routed-not-found.tsx'
import { ensureRoutedPatient } from './routed-patient-choice.ts'
import { answer, stubSmartClient } from './smart-client.test-helpers.ts'

afterEach(() => {
  cleanup()
})

/**
 * Render an app's routes at `url`: the picker at `/patients`, and a patient's
 * page at `/patients/$patientId` with a `/tab`, over a server holding only
 * patient `p1`.
 */
const renderAt = (url: string): void => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { client } = stubSmartClient({
    'Patient/p1': answer({ resourceType: 'Patient', id: 'p1' }),
    'Patient/': () => Promise.reject(Object.assign(new Error('Not Found'), { status: 404 })),
  })
  const rootRoute = createRootRoute({
    notFoundComponent: () => <RouteNotFound appName="Wildflower Test" />,
  })
  const patientRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/patients/$patientId',
    loader: ({ params }) => ensureRoutedPatient(queryClient, client, params.patientId),
    notFoundComponent: ({ data }) => <PatientRouteNotFound appName="Wildflower Test" data={data} />,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: '/patients',
        component: () => <h1>Picker</h1>,
      }),
      patientRoute.addChildren([
        createRoute({
          getParentRoute: () => patientRoute,
          path: '/tab',
          component: () => <p>Tab</p>,
        }),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [url] }),
  })
  render(<RouterProvider router={router} />)
}

describe('RouteNotFound', () => {
  it('should say the app has no page at the path, opening the picker', async () => {
    // Arrange
    renderAt('/nowhere')
    expect(await screen.findByText('Wildflower Test has no page at /nowhere.')).toBeDefined()

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Choose a patient' }))

    // Assert
    expect(await screen.findByRole('heading', { name: 'Picker' })).toBeDefined()
  })
})

describe('PatientRouteNotFound', () => {
  it('should say the server has no such patient', async () => {
    renderAt('/patients/bogus/tab')

    expect(await screen.findByText('Wildflower Test has no patient bogus.')).toBeDefined()
    expect(screen.queryByText('Tab')).toBeNull()
  })

  it('should say a path under a known patient no route names has no page', async () => {
    renderAt('/patients/p1/nowhere')

    expect(
      await screen.findByText('Wildflower Test has no page at /patients/p1/nowhere.')
    ).toBeDefined()
  })
})
