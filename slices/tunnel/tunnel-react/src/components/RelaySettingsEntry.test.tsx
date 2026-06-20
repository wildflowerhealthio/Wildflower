import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import { RelaySettingsEntry } from './RelaySettingsEntry.tsx'

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

describe('RelaySettingsEntry', () => {
  test('renders a navigable link whose href routes to the Relay settings detail page', async () => {
    renderWithRouter(<RelaySettingsEntry />)

    await waitFor(() => {
      const link = screen.getByRole('link', { name: /Relay settings/ })
      expect(link.getAttribute('href')).toBe('/settings/tunnel/relay')
    })
  })

  test('renders the "Advanced" chip alongside the title', async () => {
    renderWithRouter(<RelaySettingsEntry />)

    // The chip text sits inside the link's title; assert it's present
    // and resides under the same link as the title.
    const chip = await screen.findByText('Advanced')
    const link = await screen.findByRole('link', { name: /Relay settings/ })
    expect(link.contains(chip)).toBe(true)
  })

  test('accepts an `href` override so consumers can re-target the link', async () => {
    renderWithRouter(<RelaySettingsEntry href="/elsewhere" />)

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /Relay settings/ }).getAttribute('href')).toBe(
        '/elsewhere'
      )
    })
  })
})
