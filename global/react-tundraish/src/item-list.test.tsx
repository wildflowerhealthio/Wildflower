import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { ItemList, type ItemListItem } from './item-list.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ItemList', () => {
  it('renders nothing when items is empty', () => {
    // Arrange
    // Act
    const { container } = render(<ItemList items={[]} />)

    // Assert
    expect(container.firstChild).toBeNull()
  })

  it('renders an <a> with href when an item has href and is not disabled', () => {
    // Arrange
    const items: ItemListItem[] = [{ id: '1', title: 'Settings', href: '/settings' }]

    // Act
    render(<ItemList items={items} />)

    // Assert
    expect(screen.getByRole('link', { name: /Settings/ }).getAttribute('href')).toBe('/settings')
  })

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
})
