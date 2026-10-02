import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  makeServerServiceStatusStore,
  ServerServiceStatusProvider,
  ServerStatusBanner,
} from 'background-server-service-react'
import { Effect } from 'effect'
import {
  ActivePendingConsentProvider,
  makeActivePendingConsentStore,
  makeEmbeddedAuthStateStore,
} from 'gatekeeper-react'
import type { JSX, ReactNode } from 'react'
import { AuthStateProvider } from 'react-kitchen-sink'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { RootShell } from '../session/root-shell.tsx'
import { ServerKind } from '../session/server-kind.ts'
import { AppRootTree } from './app-root-tree.tsx'
import { stubTransport, type ReactTransport } from './transport-context.ts'

/**
 * `AppRootTree` against a minimal route tree rooted at the real `RootShell`:
 * the entry's `platformBanner` reaches the shell above the matched route, and
 * the server status banner's Restart reaches the transport through the
 * background-server-service sender forwarder in `InnerWrap`.
 */

const Leaf = (): JSX.Element => <p>route content</p>

const renderTree = ({
  platformBanner,
  sendMessage = stubTransport.sendMessage,
  statusStore = makeServerServiceStatusStore(),
}: {
  readonly platformBanner: ReactNode
  readonly sendMessage?: ReactTransport['sendMessage']
  readonly statusStore?: ReturnType<typeof makeServerServiceStatusStore>
}): void => {
  const rootRoute = createRootRoute({ component: RootShell })
  const leafRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Leaf })
  const router = createRouter({
    routeTree: rootRoute.addChildren([leafRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(
    <AuthStateProvider store={makeEmbeddedAuthStateStore()}>
      <ActivePendingConsentProvider store={makeActivePendingConsentStore()}>
        <ServerServiceStatusProvider store={statusStore}>
          <AppRootTree
            router={router}
            transportPromise={Promise.resolve({ ...stubTransport, sendMessage })}
            platformSettingsItems={[]}
            platformTabs={[]}
            platformBanner={platformBanner}
            serverKind={ServerKind.Wildflower()}
          />
        </ServerServiceStatusProvider>
      </ActivePendingConsentProvider>
    </AuthStateProvider>
  )
}

afterEach(() => {
  cleanup()
})

describe('AppRootTree platformBanner', () => {
  it('should render the entry’s banner above the matched route', async () => {
    // Act
    renderTree({ platformBanner: <aside>platform banner</aside> })

    // Assert
    const route = await screen.findByText('route content')
    const banner = screen.getByText('platform banner')
    expect(banner.compareDocumentPosition(route) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('should send the server status banner’s Restart over the app’s transport', async () => {
    // Arrange — a stopped server, as the host's snapshot would say.
    const sent: Parameters<ReactTransport['sendMessage']>[0][] = []
    const statusStore = makeServerServiceStatusStore()
    statusStore.setStatus({
      _tag: 'ServerServiceStatus',
      state: 'stopped',
      stopReason: 'userStop',
      lastError: null,
      notifications: 'granted',
    })
    renderTree({
      platformBanner: <ServerStatusBanner />,
      statusStore,
      sendMessage: (message) =>
        Effect.sync(() => {
          sent.push(message)
        }),
    })

    // Act
    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }))

    // Assert — the transport's sender also carries the navigation bridge's
    // `RouteChanged`, so only the server's message is picked out.
    expect(sent.filter((message) => message._tag === 'RestartServer')).toEqual([
      { _tag: 'RestartServer' },
    ])
  })
})
