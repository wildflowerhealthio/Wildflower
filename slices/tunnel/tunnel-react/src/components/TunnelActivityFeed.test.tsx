import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { DateTime, Option } from 'effect'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import type { ActivityCounts, RefusedStreak } from '../activity-feed.ts'
import {
  TunnelActivityFeed,
  type ActivityEntry,
  type TunnelActivityFeedProps,
} from './TunnelActivityFeed.tsx'

// A fixed "now" so all relative-time assertions are deterministic.
const NOW_MS = 1_700_000_000_000
const NOW: DateTime.DateTime = DateTime.unsafeMake(NOW_MS)

const dt = (offsetMs: number): DateTime.DateTime => DateTime.unsafeMake(NOW_MS - offsetMs)

const ENTRIES: readonly ActivityEntry[] = [
  {
    name: 'Collector',
    location: '192.0.2.1',
    lastConnectionAt: dt(0),
    access: { auth: 'authorized', clientId: 'collector' },
  },
  {
    name: 'Open',
    location: '198.51.100.24',
    lastConnectionAt: dt(2 * 60 * 1000),
    access: { auth: 'public' },
  },
  {
    name: 'No client',
    location: '203.0.113.9',
    lastConnectionAt: dt(60 * 60 * 1000),
    access: { auth: 'refused', clientId: Option.none(), reason: 'token rejected' },
  },
]

const COUNTS: ActivityCounts = { authorized: 40, public: 2, refused: 12 }

const NO_STREAKS: readonly RefusedStreak[] = []

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

const renderFeed = (
  props: Partial<Pick<TunnelActivityFeedProps, 'entries' | 'counts' | 'streaks'>> = {}
): ReturnType<typeof render> =>
  renderWithRouter(
    <TunnelActivityFeed
      entries={props.entries ?? ENTRIES}
      counts={props.counts ?? COUNTS}
      streaks={props.streaks ?? NO_STREAKS}
      now={NOW}
    />
  )

describe('TunnelActivityFeed', () => {
  test('renders the section eyebrow + "Live" cue + summary line', async () => {
    renderFeed()

    expect(await findFeedText('Recent activity')).toBeTruthy()
    expect(await findFeedText('Live')).toBeTruthy()
    // Summary = every logged request, then each access case.
    expect(
      await findFeedText('54 requests · 40 signed in · 2 no sign-in needed · 12 refused')
    ).toBeTruthy()
  })

  test('renders one row per entry with name, location, access and relative time', async () => {
    renderFeed()

    expect(await findFeedText('Collector')).toBeTruthy()
    expect(await findFeedText('192.0.2.1 · Signed in')).toBeTruthy()
    expect(await findFeedText('198.51.100.24 · No sign-in needed')).toBeTruthy()
    // Relative time on the right of each row.
    expect(await findFeedText('now')).toBeTruthy()
    expect(await findFeedText('2 min ago')).toBeTruthy()
    expect(await findFeedText('1 hr ago')).toBeTruthy()
  })

  test('refused rows surface the reason in the subtitle and the danger row tint', async () => {
    renderFeed()

    const row = (await findFeedText('203.0.113.9 · Refused · token rejected')).closest('li')
    // Class names are CSS-modules-hashed; check by substring.
    expect(row?.className).toMatch(/tone-danger/)
    expect(row?.querySelector('[class*="dot--refused"]')).not.toBeNull()
  })

  test('renders the "View all activity" footer as a navigable link', async () => {
    renderFeed()

    await waitFor(() => {
      const link = screen.getByRole('link', { name: /View all activity/ })
      expect(link.getAttribute('href')).toBe('/settings/tunnel/activity')
    })
  })

  test('singularizes the summary line for a single request', async () => {
    renderFeed({
      entries: ENTRIES.slice(0, 1),
      counts: { authorized: 1, public: 0, refused: 0 },
    })

    expect(
      await findFeedText('1 request · 1 signed in · 0 no sign-in needed · 0 refused')
    ).toBeTruthy()
  })

  test('says so when the log holds no requests', async () => {
    renderFeed({ entries: [], counts: { authorized: 0, public: 0, refused: 0 } })

    expect(await findFeedText('No requests have come through the tunnel yet.')).toBeTruthy()
  })

  test('warns about a refused streak, linking to its refused requests', async () => {
    renderFeed({ streaks: [{ address: '203.0.113.9', count: 14 }] })

    const warning = await screen.findByRole('alert')
    expect(warning.textContent).toBe(
      '14 refused requests from 203.0.113.9 in the last 10 minutes — possible credential guessing. Review'
    )
    expect(within(warning).getByRole('link', { name: 'Review' }).getAttribute('href')).toBe(
      '/settings/tunnel/activity?address=203.0.113.9&auth=refused'
    )
  })
})
