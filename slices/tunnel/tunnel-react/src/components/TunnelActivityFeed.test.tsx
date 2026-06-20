import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { DateTime } from 'effect'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import { TunnelActivityFeed, type ActivityEntry } from './TunnelActivityFeed.tsx'

// A fixed "now" so all relative-time assertions are deterministic.
const NOW_MS = 1_700_000_000_000
const NOW: DateTime.DateTime = DateTime.unsafeMake(NOW_MS)

const dt = (offsetMs: number): DateTime.DateTime => DateTime.unsafeMake(NOW_MS - offsetMs)

const ENTRIES: readonly ActivityEntry[] = [
  {
    name: 'Collector',
    location: "Ruth's iPhone",
    lastConnectionAt: dt(0),
    state: 'active',
  },
  {
    name: 'Patient app',
    location: '198.51.100.24',
    lastConnectionAt: dt(2 * 60 * 1000),
    state: 'active',
  },
  {
    name: 'Unknown client',
    location: '203.0.113.9',
    lastConnectionAt: dt(60 * 60 * 1000),
    message: 'not authorized',
    state: 'error',
  },
]

const renderWithRouter = (content: ReactNode): ReturnType<typeof render> => {
  const rootRoute = createRootRoute({ component: () => <>{content}</> })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(<RouterProvider router={router} />)
}

afterEach(() => {
  cleanup()
})

// Helper: TanStack's `<RouterProvider>` mounts asynchronously, so the
// activity-feed content (and the `<Link>` it contains) isn't in the
// DOM on the synchronous tick after `render`. `findByText` polls until
// the content lands.
const findFeedText = (text: string | RegExp): Promise<HTMLElement> => screen.findByText(text)

describe('TunnelActivityFeed', () => {
  test('renders the section eyebrow + "Live" cue + summary line', async () => {
    renderWithRouter(<TunnelActivityFeed entries={ENTRIES} now={NOW} />)

    expect(await findFeedText('Recent activity')).toBeTruthy()
    expect(await findFeedText('Live')).toBeTruthy()
    // Summary = total entries today · blocked-count.
    expect(await findFeedText('3 requests today · 1 blocked')).toBeTruthy()
  })

  test('renders one row per entry with name, location, and relative time', async () => {
    renderWithRouter(<TunnelActivityFeed entries={ENTRIES} now={NOW} />)

    // Names.
    expect(await findFeedText('Collector')).toBeTruthy()
    expect(await findFeedText('Patient app')).toBeTruthy()
    expect(await findFeedText('Unknown client')).toBeTruthy()
    // Relative time on the right of each row.
    expect(await findFeedText('now')).toBeTruthy()
    expect(await findFeedText('2 min ago')).toBeTruthy()
    // Blocked row's right-edge meta carries the "blocked · " prefix.
    expect(await findFeedText('blocked · 1 hr ago')).toBeTruthy()
  })

  test('blocked rows surface the message in the subtitle and the danger row tint', async () => {
    renderWithRouter(<TunnelActivityFeed entries={ENTRIES} now={NOW} />)

    // Message appended after the location with the bullet separator.
    expect(await findFeedText('203.0.113.9 · not authorized')).toBeTruthy()
    // The row carries the danger-tone modifier so the danger CSS tint
    // applies (class names are CSS-modules-hashed; check by substring).
    const row = (await findFeedText('Unknown client')).closest('li')
    expect(row?.className).toMatch(/tone-danger/)
  })

  test('renders the "View all activity" footer as a navigable link', async () => {
    renderWithRouter(<TunnelActivityFeed entries={ENTRIES} now={NOW} />)

    await waitFor(() => {
      const link = screen.getByRole('link', { name: /View all activity/ })
      expect(link.getAttribute('href')).toBe('/settings/tunnel/activity')
    })
  })

  test('singularizes the summary line for a single entry', async () => {
    const single: readonly ActivityEntry[] = [
      {
        name: 'Collector',
        location: "Ruth's iPhone",
        lastConnectionAt: dt(0),
        state: 'active',
      },
    ]
    renderWithRouter(<TunnelActivityFeed entries={single} now={NOW} />)

    expect(await findFeedText('1 request today · 0 blocked')).toBeTruthy()
  })
})
