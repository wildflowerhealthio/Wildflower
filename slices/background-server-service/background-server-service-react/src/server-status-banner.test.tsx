import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ServerServiceStatus } from 'background-server-service-core'
import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { ServerServiceTestProviders } from './server-service-test-providers.tsx'
import { ServerStatusBanner } from './server-status-banner.tsx'
import { makeRecordingSender, storeHolding } from './test-support.ts'

const arbitraryStatus = Arbitrary.make(Schema.typeSchema(ServerServiceStatus))

const STOPPED_WITH_BIND_ERROR: ServerServiceStatus = {
  _tag: 'ServerServiceStatus',
  state: 'stopped',
  stopReason: 'platformExpiration',
  lastError: 'failed to bind to 127.0.0.1:8080: Address already in use',
  notifications: 'granted',
}

/**
 * Render the banner under a memory router at `path`, as the app shell does,
 * and wait for the router's first load.
 */
const renderBanner = async (
  status: ServerServiceStatus | null,
  path = '/'
): Promise<
  ReturnType<typeof makeRecordingSender> &
    ReturnType<typeof render> & { readonly store: ReturnType<typeof storeHolding> }
> => {
  const store = storeHolding(status)
  const sender = makeRecordingSender()
  const rootRoute = createRootRoute({ component: ServerStatusBanner })
  const router = createRouter({
    routeTree: rootRoute.addChildren(
      ['/', '/settings/server'].map((routePath) =>
        createRoute({ getParentRoute: () => rootRoute, path: routePath })
      )
    ),
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  const rendered = render(
    <ServerServiceTestProviders store={store} send={sender.send}>
      <RouterProvider router={router} />
    </ServerServiceTestProviders>
  )
  await act(() => router.load())
  return { ...sender, ...rendered, store }
}

/** The banner's strip, or `null` when it shows none. */
const queryStrip = (): HTMLElement | null =>
  screen.queryByRole('region', { name: 'Wildflower server' })

/** The banner's strip. */
const getStrip = (): HTMLElement => screen.getByRole('region', { name: 'Wildflower server' })

afterEach(() => {
  cleanup()
})

describe('ServerStatusBanner', () => {
  it('should render nothing before the first snapshot arrives', async () => {
    // Act
    await renderBanner(null)

    // Assert
    expect(queryStrip()).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('should render nothing for any running status', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitraryStatus.map((status) => ({ ...status, state: 'running' as const })),
        async (status) => {
          // Act
          const { unmount } = await renderBanner(status)

          // Assert
          expect(queryStrip()).toBeNull()
          expect(screen.getByRole('status').textContent).toBe('')
          unmount()
        }
      ),
      { numRuns: numRunsFor({ base: 25 }) }
    )
  })

  it('should show a stopped server’s stop reason and error, with Restart', async () => {
    // Act
    await renderBanner(STOPPED_WITH_BIND_ERROR)

    // Assert
    const strip = within(getStrip())
    expect(strip.getByText('Server stopped')).toBeDefined()
    expect(strip.getByText('iOS ended the background window.')).toBeDefined()
    expect(
      strip.getByText('failed to bind to 127.0.0.1:8080: Address already in use')
    ).toBeDefined()
    expect(screen.getByRole('button', { name: 'Restart' })).toBeDefined()
  })

  it('should show a starting server calmly, without a reason, an error or Restart', async () => {
    // Act — a restart's starting run still carries its own `appStop`.
    await renderBanner({
      _tag: 'ServerServiceStatus',
      state: 'starting',
      stopReason: 'appStop',
      lastError: null,
      notifications: 'granted',
    })

    // Assert
    expect(queryStrip()?.textContent).toBe('Server starting…')
    expect(screen.getByRole('status').textContent).toBe('Server starting…')
    expect(screen.queryByText(/restart\./i)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull()
  })

  it('should show the stop half of a restart calmly, as restarting', async () => {
    // Act — the old run has stopped with `appStop`; the new one hasn't started.
    await renderBanner({
      _tag: 'ServerServiceStatus',
      state: 'stopped',
      stopReason: 'appStop',
      lastError: null,
      notifications: 'granted',
    })

    // Assert
    expect(queryStrip()?.textContent).toBe('Server restarting…')
    expect(screen.getByRole('status').textContent).toBe('Server restarting…')
    expect(screen.queryByText(/restart\./i)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull()
  })

  it('should render nothing on the server page, which shows the same status in full', async () => {
    // Act
    await renderBanner(STOPPED_WITH_BIND_ERROR, '/settings/server')

    // Assert
    expect(queryStrip()).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('should send RestartServer when Restart is pressed', async () => {
    // Arrange
    const { sent } = await renderBanner(STOPPED_WITH_BIND_ERROR)

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Restart' }))

    // Assert
    expect(sent).toEqual([{ _tag: 'RestartServer' }])
  })

  it('should announce each status it shows through a live region mounted before it', async () => {
    // Arrange
    const { store } = await renderBanner(null)
    const liveRegion = screen.getByRole('status')

    // Act
    act(() => {
      store.setStatus(STOPPED_WITH_BIND_ERROR)
    })

    // Assert — the same element, now holding the strip's text.
    await waitFor(() => {
      expect(screen.getByRole('status')).toBe(liveRegion)
    })
    expect(liveRegion.textContent).toBe(
      'Server stopped. iOS ended the background window. failed to bind to 127.0.0.1:8080: Address already in use'
    )
    expect(queryStrip()?.querySelector('[role="status"], [role="alert"]')).toBeNull()
  })

  it('should disappear when the next snapshot says the server is running', async () => {
    // Arrange
    const { store } = await renderBanner(STOPPED_WITH_BIND_ERROR)

    // Act
    act(() => {
      store.setStatus({ ...STOPPED_WITH_BIND_ERROR, state: 'running', lastError: null })
    })

    // Assert
    await waitFor(() => {
      expect(queryStrip()).toBeNull()
    })
    expect(screen.getByRole('status').textContent).toBe('')
  })
})
