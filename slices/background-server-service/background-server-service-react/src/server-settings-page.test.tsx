import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ServerServiceStatus } from 'background-server-service-core'
import { Effect, Layer, pipe } from 'effect'
import { Tunnel } from 'tunnel-core/http-api-definition'
import { TunnelRouterContext } from 'tunnel-react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import type { RouterContext, RunAuthed } from './router-context.ts'
import { routeTree } from './routeTree.gen.ts'
import { ServerServiceTestProviders } from './server-service-test-providers.tsx'
import { makeRecordingSender, storeHolding } from './test-support.ts'

type TunnelState = typeof Tunnel.TunnelStateViewSchema.Type

const ONLINE_TUNNEL: TunnelState = {
  ...Tunnel.freshTunnelState,
  publicHost: 'ruth.wildflowerhealth.io',
  requestedRunning: true,
  running: true,
  status: 'verified',
}

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

/**
 * A `runAuthed` over the real tunnel client, whose `HttpClient` answers every
 * request with `tunnelState` and counts the requests it saw.
 */
const runAuthedServing = (
  tunnelState: TunnelState
): { readonly runAuthed: RunAuthed; readonly requests: () => number } => {
  let requestCount = 0
  const httpClientLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requestCount += 1
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(tunnelState), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        )
      })
    )
  )
  const runtimeLayer = pipe(
    TunnelRouterContext.sliceRuntimeLayer,
    Layer.provideMerge(httpClientLayer)
  )
  return {
    runAuthed: (effect) =>
      Effect.runPromise(effect.pipe(Effect.provide(runtimeLayer), Effect.scoped)),
    requests: () => requestCount,
  }
}

/** Render `/settings/server` through the slice's own route tree. */
const renderServerSettings = (
  status: ServerServiceStatus | null
): ReturnType<typeof makeRecordingSender> & { readonly tunnelRequests: () => number } => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { runAuthed, requests } = runAuthedServing(ONLINE_TUNNEL)
  const context: RouterContext = {
    queryClient,
    runAuthed,
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
  return { ...sender, tunnelRequests: requests }
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
    expect(screen.queryByText('Tunnel')).toBeNull()
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

  it('should show a stopped server’s reason, error and notification permission, and no tunnel', async () => {
    // Act
    const { tunnelRequests } = renderServerSettings(
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
    expect(
      screen.getByText(
        'The tunnel runs inside the server, so there is no tunnel while it is stopped.'
      )
    ).toBeDefined()
    expect(tunnelRequests()).toBe(0)
  })

  it('should say the tunnel waits for a starting server', async () => {
    // Act
    const { tunnelRequests } = renderServerSettings(
      statusIn('starting', { stopReason: 'appStop', notifications: 'unknown' })
    )

    // Assert
    expect(await screen.findByText('The tunnel starts once the server is running.')).toBeDefined()
    expect(screen.getByText('Not decided yet')).toBeDefined()
    expect(tunnelRequests()).toBe(0)
  })

  it('should show the tunnel’s status and public host while the server runs', async () => {
    // Act
    const { tunnelRequests } = renderServerSettings(statusIn('running'))

    // Assert
    expect(await screen.findByText('ruth.wildflowerhealth.io')).toBeDefined()
    expect(screen.getByText('Online')).toBeDefined()
    expect(screen.getByText('None yet')).toBeDefined()
    expect(tunnelRequests()).toBe(1)
  })
})
