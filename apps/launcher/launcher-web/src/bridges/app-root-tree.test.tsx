import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import {
  ActivePendingConsentProvider,
  makeActivePendingConsentStore,
  makeEmbeddedAuthStateStore,
} from '@wildflowerhealthio/gatekeeper-react'
import { AuthStateProvider } from '@wildflowerhealthio/react-kitchen-sink'
import type { JSX, ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { RootShell } from '../session/root-shell.tsx'
import { ServerKind } from '../session/server-kind.ts'
import { AppRootTree } from './app-root-tree.tsx'
import { stubTransport } from './transport-context.ts'

/**
 * `AppRootTree` against a minimal route tree rooted at the real `RootShell`:
 * the entry's `platformBanner` reaches the shell above the matched route.
 */

const Leaf = (): JSX.Element => <p>route content</p>

const renderTree = ({ platformBanner }: { readonly platformBanner: ReactNode }): void => {
  const rootRoute = createRootRoute({ component: RootShell })
  const leafRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Leaf })
  const router = createRouter({
    routeTree: rootRoute.addChildren([leafRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(
    <AuthStateProvider store={makeEmbeddedAuthStateStore()}>
      <ActivePendingConsentProvider store={makeActivePendingConsentStore()}>
        <AppRootTree
          router={router}
          transportPromise={Promise.resolve(stubTransport)}
          platformSettingsItems={[]}
          platformTabs={[]}
          platformBanner={platformBanner}
          serverKind={ServerKind.Wildflower()}
        />
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
})
