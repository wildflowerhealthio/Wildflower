import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useSearch,
} from '@tanstack/react-router'
import type { RouterHistory } from '@tanstack/react-router'
import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import type { JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { RouteTabs } from './route-tabs.tsx'
import styles from './route-tabs.module.css'

type ServerTab = 'status' | 'access' | 'relay' | 'certificate'

const serverTabs: readonly { id: ServerTab; label: string }[] = [
  { id: 'status', label: 'Status' },
  { id: 'access', label: 'Access' },
  { id: 'relay', label: 'Relay' },
  { id: 'certificate', label: 'Certificate' },
]

const isServerTab = (value: unknown): value is ServerTab =>
  serverTabs.some((tab) => tab.id === value)

/** The server route's search: an optional `tab`, and a `filter` the tabs must keep. */
const validateServerSearch = (
  search: Readonly<Record<string, unknown>>
): { tab?: ServerTab; filter?: string } => ({
  ...(isServerTab(search['tab']) ? { tab: search['tab'] } : {}),
  ...(typeof search['filter'] === 'string' ? { filter: search['filter'] } : {}),
})

/**
 * The server page: its tabs over a line naming the open one. With no `tab`
 * in the URL it opens on Status, a default the router can't see, so only
 * `current` says which tab is open.
 */
const ServerPage = (): JSX.Element => {
  const tab = validateServerSearch(useSearch({ strict: false })).tab ?? 'status'
  return (
    <RouteTabs current={tab} tabs={serverTabs} aria-label="Server details">
      <p>{`${tab} panel`}</p>
    </RouteTabs>
  )
}

/**
 * Mount {@link ServerPage} at `/servers/example`, beside a `/` home page,
 * with `history` holding `initialEntries` and open on the last.
 */
const renderServerPage = (initialEntries: string[]): RouterHistory => {
  const history = createMemoryHistory({ initialEntries, initialIndex: initialEntries.length - 1 })
  const rootRoute = createRootRoute()
  const serverRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/servers/example',
    validateSearch: validateServerSearch,
    component: ServerPage,
  })
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <p>Home</p>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([homeRoute, serverRoute]),
    history,
  })
  render(<RouterProvider router={router} />)
  return history
}

/** A {@link ResizeObserver} that never fires: jsdom has none, and has no layout to observe. */
class StillResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', StillResizeObserver)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('RouteTabs', () => {
  it('marks the current tab, and only it, as the current page', async () => {
    // Arrange / Act
    renderServerPage(['/servers/example?tab=relay'])

    // Assert
    const relay = await screen.findByRole('link', { name: 'Relay' })
    expect(relay.getAttribute('aria-current')).toBe('page')
    const others = screen
      .getAllByRole('link')
      .filter((link) => link !== relay && link.hasAttribute('aria-current'))
    expect(others).toEqual([])
  })

  it('marks the route’s default tab current when the URL has no `tab`', async () => {
    // Arrange / Act
    renderServerPage(['/servers/example'])

    // Assert
    const status = await screen.findByRole('link', { name: 'Status' })
    expect(status.getAttribute('aria-current')).toBe('page')
    expect(screen.getByText('status panel')).toBeDefined()
  })

  it('links each tab to the same route with its `tab` set and other params kept', async () => {
    // Arrange / Act
    renderServerPage(['/servers/example?tab=status&filter=recent'])

    // Assert
    await screen.findByRole('navigation', { name: 'Server details' })
    const hrefs = screen.getAllByRole('link').map((link) => {
      const url = new URL(link.getAttribute('href') ?? '', 'https://host.example')
      return {
        path: url.pathname,
        tab: url.searchParams.get('tab'),
        filter: url.searchParams.get('filter'),
      }
    })
    expect(hrefs).toEqual(
      serverTabs.map((tab) => ({ path: '/servers/example', tab: tab.id, filter: 'recent' }))
    )
  })

  it('navigates with `replace`, so Back leaves the page instead of stepping through tabs', async () => {
    // Arrange
    const history = renderServerPage(['/', '/servers/example?tab=status'])
    const user = userEvent.setup()

    // Act
    await user.click(await screen.findByRole('link', { name: 'Relay' }))

    // Assert
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Relay' }).getAttribute('aria-current')).toBe('page')
    })
    expect(screen.getByText('relay panel')).toBeDefined()
    expect(history.length).toBe(2)
    history.back()
    expect(await screen.findByText('Home')).toBeDefined()
  })

  it('scrolls an overflowing strip to bring the current tab into view', async () => {
    // Arrange: a 200px strip holding four 120px tabs side by side.
    const tabWidth = 120
    const tabIndex = (element: HTMLElement): number =>
      serverTabs.findIndex((tab) => tab.label === element.textContent)
    const isStrip = (element: HTMLElement): boolean => element.tagName === 'NAV'
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return Math.max(tabIndex(this), 0) * tabWidth
    })
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return tabIndex(this) >= 0 ? tabWidth : 0
    })
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
      return this instanceof HTMLElement && isStrip(this) ? 200 : 0
    })
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) {
      return this instanceof HTMLElement && isStrip(this) ? serverTabs.length * tabWidth : 0
    })

    // Act
    renderServerPage(['/servers/example?tab=relay'])

    // Assert: Relay spans 240–360px, so the strip scrolls until its end shows.
    const strip = await screen.findByRole('navigation', { name: 'Server details' })
    await waitFor(() => {
      expect(strip.scrollLeft).toBe(360 - 200)
    })
    expect(strip.classList.contains(styles['route-tabs__strip--hidden-before'] ?? '')).toBe(true)
    expect(strip.classList.contains(styles['route-tabs__strip--hidden-after'] ?? '')).toBe(true)
  })

  it('leaves a strip that fits unscrolled and unfaded', async () => {
    // Arrange / Act: jsdom has no layout, so every tab already fits.
    renderServerPage(['/servers/example?tab=certificate'])

    // Assert
    const strip = await screen.findByRole('navigation', { name: 'Server details' })
    expect(strip.scrollLeft).toBe(0)
    expect(strip.classList.contains(styles['route-tabs__strip--hidden-before'] ?? '')).toBe(false)
    expect(strip.classList.contains(styles['route-tabs__strip--hidden-after'] ?? '')).toBe(false)
  })
})
