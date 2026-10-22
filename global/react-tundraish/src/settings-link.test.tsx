import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { SettingsLink } from './settings-link.tsx'
import type { SettingsLinkProps } from './settings-link.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

/**
 * Mount a {@link SettingsLink} inside a minimal router, which its `<Link>`
 * needs, with any extra root props.
 */
const renderSettingsLink = (
  rootProps: Omit<SettingsLinkProps, 'href' | 'label'> & Record<`data-${string}`, string> = {}
): void => {
  const rootRoute = createRootRoute({
    component: () => <SettingsLink {...rootProps} href="/settings" label="Host Settings" />,
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

  it('passes other props to its link, adding a class to its own', async () => {
    // Arrange / Act
    renderSettingsLink({ className: 'extra', 'data-walkthrough': 'settings' })

    // Assert
    const link = await screen.findByRole('link', { name: 'Host Settings' })
    expect(link.getAttribute('data-walkthrough')).toBe('settings')
    expect(link.classList.contains('extra')).toBe(true)
    expect(link.classList.contains('ghost')).toBe(true)
    expect(link.getAttribute('aria-label')).toBe('Host Settings')
  })
})
