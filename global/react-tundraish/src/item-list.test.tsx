import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { ItemList, type ItemListItem } from './item-list.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

/**
 * Mount `content` inside a minimal TanStack router so any `<Link>` inside
 * `ItemList` resolves its `RouterContext`. The router only exists for
 * link rendering — no navigation is exercised here.
 */
const renderWithRouter = (content: ReactNode): ReturnType<typeof render> => {
  const rootRoute = createRootRoute({ component: () => <>{content}</> })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(<RouterProvider router={router} />)
}

describe('ItemList', () => {
  it('renders nothing when items is empty', () => {
    // Arrange
    // Act
    const { container } = render(<ItemList items={[]} />)

    // Assert
    expect(container.firstChild).toBeNull()
  })

  // First-render React Testing Library setup (jsdom environment + render) can
  // exceed the 5s default under the CPU contention of `vp run -r test`. Bumped
  // for headroom; cheap once the renderer has warmed up for later tests.
  it('renders an <a> with href when an item has href and is not disabled', async () => {
    // Arrange
    const items: ItemListItem[] = [{ id: '1', title: 'Settings', href: '/settings' }]

    // Act — `/`-prefixed hrefs render through TanStack's `<Link>`, which
    // requires a router context; mount under a minimal router so the test
    // exercises the same code path real consumers do.
    renderWithRouter(<ItemList items={items} />)

    // Assert — TanStack's `<RouterProvider>` resolves its first match
    // asynchronously, so we wait for the link to materialize.
    await waitFor(() => {
      expect(screen.getByRole('link', { name: /Settings/ }).getAttribute('href')).toBe('/settings')
    })
  }, 15_000)

  it('does NOT render a navigable link when href is set but the item is disabled', () => {
    // Arrange
    const items: ItemListItem[] = [
      { id: '1', title: 'Settings', href: '/settings', disabled: true },
    ]

    // Act
    render(<ItemList items={items} />)

    // Assert — no <a> element exists, so disabled+href can't navigate
    expect(screen.queryByRole('link')).toBeNull()
    // But the row content is still rendered
    expect(screen.getByText('Settings')).toBeTruthy()
  })

  it('renders a button when no href is provided and fires onClick when clicked', async () => {
    // Arrange
    const onClick = vi.fn()
    const items: ItemListItem[] = [{ id: '1', title: 'Logout', onClick }]
    const user = userEvent.setup()
    render(<ItemList items={items} />)

    // Act
    await user.click(screen.getByRole('button', { name: /Logout/ }))

    // Assert
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('does not fire onClick when the button is disabled', async () => {
    // Arrange
    const onClick = vi.fn()
    const items: ItemListItem[] = [{ id: '1', title: 'Logout', onClick, disabled: true }]
    const user = userEvent.setup()
    render(<ItemList items={items} />)

    // Act
    await user.click(screen.getByRole('button', { name: /Logout/ }))

    // Assert
    expect(onClick).not.toHaveBeenCalled()
  })

  it('does not fire the row onClick when an interactive element inside actions is clicked', async () => {
    // Arrange — interactive `actions` (e.g. a kebab menu trigger) sit
    // inside the row's wrapping `<button>`. Without click-bubble
    // suppression, hitting the action ALSO fires the row's primary
    // navigation — exactly the bug that broke collector's "open menu"
    // (it kept jumping to the edit page instead).
    const onRowClick = vi.fn()
    const onActionClick = vi.fn()
    const items: ItemListItem[] = [
      {
        id: '1',
        title: 'Account A',
        onClick: onRowClick,
        actions: (
          <button type="button" onClick={onActionClick}>
            ⋮
          </button>
        ),
      },
    ]
    const user = userEvent.setup()
    render(<ItemList items={items} />)

    // Act — click the inner kebab button, NOT the row text.
    await user.click(screen.getByRole('button', { name: '⋮' }))

    // Assert — only the action handler ran; the row's onClick was suppressed.
    expect(onActionClick).toHaveBeenCalledTimes(1)
    expect(onRowClick).not.toHaveBeenCalled()
  })
})
