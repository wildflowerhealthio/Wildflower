import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { PageHeader } from './page-header.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

/**
 * Mount `content` inside a minimal TanStack router so the back `<Link>`
 * resolves its `RouterContext`. The router only exists for link
 * rendering — no navigation is exercised here.
 */
const renderWithRouter = (content: ReactNode): ReturnType<typeof render> => {
  const rootRoute = createRootRoute({ component: () => <>{content}</> })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(<RouterProvider router={router} />)
}

describe('PageHeader', () => {
  it('renders the title as a single level-1 heading', () => {
    // Arrange / Act
    render(<PageHeader title="Settings" />)

    // Assert
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy()
  })

  it('renders no back link when backHref is omitted', () => {
    // Arrange / Act — a top-level (tab) surface has nowhere to go back to.
    render(<PageHeader title="Apps" />)

    // Assert
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('renders a back link to the parent path when backHref is set', async () => {
    // Arrange / Act
    renderWithRouter(<PageHeader title="Tunnel" backHref="/settings" />)

    // Assert — the link points at the fixed parent and is named "Back".
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Back' }).getAttribute('href')).toBe('/settings')
    })
  })

  it('uses a custom back label when provided', async () => {
    // Arrange / Act
    renderWithRouter(
      <PageHeader title="Request" backHref="/settings/gatekeeper" backLabel="Back to access" />
    )

    // Assert
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Back to access' })).toBeTruthy()
    })
  })

  it('renders trailing actions alongside the title', () => {
    // Arrange / Act
    render(<PageHeader title="Apps" actions={<button type="button">Manage</button>} />)

    // Assert
    expect(screen.getByRole('button', { name: 'Manage' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1, name: 'Apps' })).toBeTruthy()
  })
})
