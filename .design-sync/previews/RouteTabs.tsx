import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { useState } from 'react'
import { ItemList, RouteTabs, type RouteTab } from '@wildflowerhealthio/react-tundraish'

type ServerTab = 'status' | 'access' | 'default-apps' | 'relay' | 'certificate'

/** The server page's tabs (apps/host/servers/servers-react). */
const serverTabs: readonly RouteTab<ServerTab>[] = [
  { id: 'status', label: 'Status' },
  { id: 'access', label: 'Access' },
  { id: 'default-apps', label: 'Default Apps' },
  { id: 'relay', label: 'Relay' },
  { id: 'certificate', label: 'Certificate' },
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

const isServerTab = (value: unknown): value is ServerTab =>
  serverTabs.some((tab) => tab.id === value)

/**
 * The server page in a memory router, so the tabs' `<Link>`s have a route to
 * set `tab` on. Each cell builds its own, opening on `initialTab`.
 */
const ServerPage = ({ initialTab, width }: { initialTab: ServerTab; width: number }) => {
  const [router] = useState(() => {
    const rootRoute = createRootRoute({
      validateSearch: (search: Record<string, unknown>) => ({
        tab: isServerTab(search['tab']) ? search['tab'] : 'status',
      }),
      component: function Page() {
        const { tab } = rootRoute.useSearch()
        return (
          <RouteTabs current={tab} tabs={serverTabs} aria-label="Server details">
            <ItemList items={panels[tab]} />
          </RouteTabs>
        )
      },
    })
    return createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: [`/?tab=${initialTab}`] }),
    })
  })
  return (
    <div style={{ width, maxWidth: '100%' }}>
      <RouterProvider router={router} />
    </div>
  )
}

/** From 560px of width: a pill track above the unframed panel, the current tab raised. */
export const Wide = () => <ServerPage initialTab="status" width={640} />

/** Below 560px: the strip is the top edge of a card holding the panel. */
export const Narrow = () => <ServerPage initialTab="access" width={360} />

/**
 * A strip too narrow for its tabs scrolls sideways, keeps the current tab in
 * view, and fades the end with tabs past it.
 */
export const Overflowing = () => <ServerPage initialTab="certificate" width={300} />
