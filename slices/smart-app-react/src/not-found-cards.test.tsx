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

import { NoPageCard, NoPatientCard } from './not-found-cards.tsx'
import { requirePatient } from './patient-route.ts'
import { answer, stubSmartClient } from './smart-client.test-helpers.ts'

afterEach(() => {
  cleanup()
})

/**
 * Render an app's routes at `url`, as a routed app's router sets them up
 * (`notFoundMode: 'root'`): the picker at `/patients`, and a patient's page
 * at `/patients/$patientId` with a `/tab`, over a server holding only patient
 * `p1`.
 */
const renderAt = (url: string): void => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { client } = stubSmartClient({
    'Patient/p1': answer({ resourceType: 'Patient', id: 'p1' }),
    'Patient/': () => Promise.reject(Object.assign(new Error('Not Found'), { status: 404 })),
  })
  const rootRoute = createRootRoute({ notFoundComponent: NoPageCard })
  const patientRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/patients/$patientId',
    loader: ({ params }) => requirePatient(queryClient, client, params.patientId),
    notFoundComponent: NoPatientCard,
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
    notFoundMode: 'root',
  })
  render(<RouterProvider router={router} />)
}

describe('NoPageCard', () => {
  it('should say there is no page at the path, opening the picker', async () => {
    // Arrange
    renderAt('/nowhere')
    expect(await screen.findByText("There's no page at /nowhere.")).toBeDefined()

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Choose a patient' }))

    // Assert
    expect(await screen.findByRole('heading', { name: 'Picker' })).toBeDefined()
  })

  it('should say a path under a known patient no route names has no page', async () => {
    renderAt('/patients/p1/nowhere')

    expect(await screen.findByText("There's no page at /patients/p1/nowhere.")).toBeDefined()
  })
})

describe('NoPatientCard', () => {
  it('should say the server has no patient the path names, opening the picker', async () => {
    // Arrange
    renderAt('/patients/bogus/tab')
    expect(await screen.findByText('This server has no patient bogus.')).toBeDefined()
    expect(screen.queryByText('Tab')).toBeNull()

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Choose a patient' }))

    // Assert
    expect(await screen.findByRole('heading', { name: 'Picker' })).toBeDefined()
  })
})
