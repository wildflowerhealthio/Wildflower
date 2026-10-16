import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  RouterProvider,
} from '@tanstack/react-router'
import { useState } from 'react'
import { ItemList, RouteTabs } from '@wildflowerhealthio/react-tundraish'

type ServerTab = 'status' | 'access' | 'default-apps' | 'relay' | 'certificate'

/** The server page's tabs (apps/host/servers/servers-react), each a child route. */
const serverTabs: readonly { segment: ServerTab; label: string }[] = [
  { segment: 'status', label: 'Status' },
  { segment: 'access', label: 'Access' },
  { segment: 'default-apps', label: 'Default Apps' },
  { segment: 'relay', label: 'Relay' },
  { segment: 'certificate', label: 'Certificate' },
]

const panels: Record<ServerTab, readonly { id: string; title: string; subtitle: string }[]> = {
  status: [
    { id: 'connection', title: 'Connection', subtitle: 'Reachable: its /health answers pass.' },
    { id: 'relay', title: 'Relay connection', subtitle: 'Connected.' },
  ],
  access: [{ id: 'request', title: 'Pending request', subtitle: 'Plots wants access.' }],
  'default-apps': [
    { id: 'launcher', title: 'Launcher', subtitle: 'https://wildflowerhealth.io/app/' },
    { id: 'authorization', title: 'Authorization', subtitle: 'https://wildflowerhealth.io/access/' },
  ],
  relay: [
    { id: 'relay', title: 'Relay', subtitle: 'Wildflower relay' },
    { id: 'tunnel', title: 'Tunnel name', subtitle: 'ruth-laptop' },
  ],
  certificate: [
    { id: 'status', title: 'Status', subtitle: 'Valid.' },
    { id: 'ca', title: 'Certificate authority', subtitle: "Let's Encrypt" },
  ],
}

/**
 * The server page in its own memory router: the root route renders the
 * tabs, each tab is a child route filling the panel, and the index route
 * redirects to the first tab. Each cell builds its own, open on
 * `initialTab`. The shape follows the cell's width (`wideFromOwnWidth`), so
 * a cell shows the same shape at any preview viewport.
 */
const ServerPage = ({ initialTab, width }: { initialTab: ServerTab; width: number }) => {
  const [router] = useState(() => {
    const rootRoute = createRootRoute({
      component: () => (
        <RouteTabs
          tabs={serverTabs.map((tab) => ({ to: `/${tab.segment}`, label: tab.label }))}
          aria-label="Server details"
          wideFromOwnWidth={480}
        />
      ),
    })
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      beforeLoad: () => {
        throw redirect({ to: '/status', replace: true })
      },
    })
    const tabRoutes = serverTabs.map((tab) =>
      createRoute({
        getParentRoute: () => rootRoute,
        path: tab.segment,
        component: () => <ItemList items={panels[tab.segment]} />,
      })
    )
    return createRouter({
      routeTree: rootRoute.addChildren([indexRoute, ...tabRoutes]),
      history: createMemoryHistory({ initialEntries: [`/${initialTab}`] }),
    })
  })
  return (
    <div style={{ width, maxWidth: '100%' }}>
      <RouterProvider router={router} />
    </div>
  )
}

/** Wide (from 768px of viewport in apps; 480px of its own width here): a pill track above the unframed panel. */
export const Wide = () => <ServerPage initialTab="status" width={640} />

/** Narrow: the strip is the top edge of a card holding the panel. */
export const Narrow = () => <ServerPage initialTab="access" width={360} />

/**
 * A strip too narrow for its tabs scrolls sideways, keeps the current tab
 * clear of the fades, and fades each end with tabs past it.
 */
export const Overflowing = () => <ServerPage initialTab="certificate" width={300} />
