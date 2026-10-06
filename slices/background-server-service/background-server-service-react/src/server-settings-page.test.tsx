import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ServerServiceStatus } from 'background-server-service-core'
import { Layer } from 'effect'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import type { RouterContext } from './router-context.ts'
import { routeTree } from './routeTree.gen.ts'
import { ServerServiceTestProviders } from './server-service-test-providers.tsx'
import { makeRecordingSender, storeHolding } from './test-support.ts'

const statusIn = (
  state: ServerServiceStatus['state'],
  fields: Partial<Omit<ServerServiceStatus, '_tag' | 'state'>> = {}
): ServerServiceStatus => ({
  _tag: 'ServerServiceStatus',
  state,
  stopReason: null,
  lastError: null,
  notifications: 'granted',
  ...fields,
})

/** Render `/settings/server` through the slice's own route tree. */
const renderServerSettings = (
  status: ServerServiceStatus | null
): ReturnType<typeof makeRecordingSender> => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const context: RouterContext = {
    queryClient,
    runAuthed: () => Promise.reject(new Error('runAuthed not used by the server page')),
    runtimeLayer: Layer.die('runtimeLayer not used by the server page'),
    awaitAuthReady: () => Promise.resolve(),
  }
  const router = createRouter({
    routeTree,
    context,
    history: createMemoryHistory({ initialEntries: ['/settings/server'] }),
  })
  const sender = makeRecordingSender()
  render(
    <QueryClientProvider client={queryClient}>
      <ServerServiceTestProviders store={storeHolding(status)} send={sender.send}>
        <RouterProvider router={router} />
      </ServerServiceTestProviders>
    </QueryClientProvider>
  )
  return sender
}

afterEach(() => {
  cleanup()
})

describe('/settings/server', () => {
  it('should say it is waiting before the first snapshot arrives', async () => {
    // Act
    renderServerSettings(null)

    // Assert
    expect(await screen.findByText('Waiting for the server status…')).toBeDefined()
  })

  it.each([
    ['starting', 'Starting'],
    ['running', 'Running'],
    ['stopped', 'Stopped'],
  ] as const)('should show the %s state and offer Restart', async (state, label) => {
    // Arrange
    const { sent } = renderServerSettings(statusIn(state))

    // Act
    await userEvent.click(await screen.findByRole('button', { name: 'Restart' }))

    // Assert
    expect(screen.getByText(label)).toBeDefined()
    expect(sent).toEqual([{ _tag: 'RestartServer' }])
  })

  it('should show a stopped server’s reason, error and notification permission', async () => {
    // Act
    renderServerSettings(
      statusIn('stopped', {
        stopReason: 'error',
        lastError: 'failed to open shared database: disk I/O error',
        notifications: 'denied',
      })
    )

    // Assert
    expect(await screen.findByText('It stopped after an error.')).toBeDefined()
    expect(screen.getByText('failed to open shared database: disk I/O error')).toBeDefined()
    expect(screen.getByText('Off')).toBeDefined()
  })

  it('should show an unknown notification permission', async () => {
    // Act
    renderServerSettings(statusIn('starting', { stopReason: 'appStop', notifications: 'unknown' }))

    // Assert
    expect(await screen.findByText('Unknown')).toBeDefined()
  })

  it('should say a running server has not stopped yet', async () => {
    // Act
    renderServerSettings(statusIn('running'))

    // Assert
    expect(await screen.findByText('None yet')).toBeDefined()
  })

  it('should show the stop half of a restart as restarting, not as a stop', async () => {
    // Act
    renderServerSettings(statusIn('stopped', { stopReason: 'appStop' }))

    // Assert
    expect(await screen.findByText('Restarting')).toBeDefined()
    expect(screen.queryByText('Stopped')).toBeNull()
  })
})
