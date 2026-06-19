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

  it('renders a static (non-interactive) row when neither href nor onClick is provided', () => {
    // Arrange — a read-only feed entry has no destination and no
    // primary action; the row must render without becoming a link or
    // a button.
    const items: ItemListItem[] = [{ id: '1', title: 'Collector', subtitle: 'now' }]

    // Act
    render(<ItemList items={items} />)

    // Assert
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('Collector')).toBeTruthy()
    expect(screen.getByText('now')).toBeTruthy()
  })

  it('renders the leading slot before the row text', () => {
    // Arrange
    const items: ItemListItem[] = [
      { id: '1', title: 'Collector', leading: <span data-testid="dot" /> },
    ]

    // Act
    render(<ItemList items={items} />)

    // Assert — the leading element is present, marked aria-hidden
    // (it's decorative), and appears before the title text in DOM order.
    const dot = screen.getByTestId('dot')
    const title = screen.getByText('Collector')
    expect(dot.parentElement?.getAttribute('aria-hidden')).toBe('true')
    expect(dot.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders the meta slot inside the title row (sibling to the name)', () => {
    // Arrange — meta carries compact title-row metadata (e.g. a
    // relative timestamp). It must share the title's baseline, not
    // appear on the subtitle line.
    const items: ItemListItem[] = [{ id: '1', title: 'Collector', meta: 'now' }]

    // Act
    render(<ItemList items={items} />)

    // Assert — the meta element shares a parent with the title.
    const title = screen.getByText('Collector')
    const meta = screen.getByText('now')
    expect(meta.parentElement).toBe(title.parentElement)
  })

  it('applies the danger tone class on the row when tone="danger"', () => {
    // Arrange
    const items: ItemListItem[] = [{ id: '1', title: 'Unknown client', tone: 'danger' }]

    // Act
    render(<ItemList items={items} />)

    // Assert — the row carries a danger-tone modifier so the CSS
    // tint applies; class name uses CSS-modules hashing, so check
    // for the unhashed token in the row's className.
    const row = screen.getByText('Unknown client').closest('li')
    expect(row?.className).toMatch(/tone-danger/)
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
