import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { SettingsLink } from './settings-link.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

/** Mount a {@link SettingsLink} inside a minimal router, which its `<Link>` needs. */
const renderSettingsLink = (): void => {
  const rootRoute = createRootRoute({
    component: () => <SettingsLink href="/settings" label="Host Settings" />,
  })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(<RouterProvider router={router} />)
}

describe('SettingsLink', () => {
  it('links to its settings screen, named by its label', async () => {
    // Arrange / Act
    renderSettingsLink()

    // Assert
    const link = await screen.findByRole('link', { name: 'Host Settings' })
    expect(link.getAttribute('href')).toBe('/settings')
    expect(link.getAttribute('title')).toBe('Host Settings')
  })

  it('shows the gear, hidden from assistive technology', async () => {
    // Arrange / Act
    renderSettingsLink()

    // Assert
    const link = await screen.findByRole('link', { name: 'Host Settings' })
    expect(link.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  })
})
