import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { Menu, type MenuItem } from './menu.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

const buildItems = (overrides: Partial<Record<string, Partial<MenuItem>>> = {}): MenuItem[] => [
  { id: 'rename', label: 'Rename', onSelect: vi.fn(), ...overrides.rename },
  { id: 'archive', label: 'Archive', onSelect: vi.fn(), ...overrides.archive },
  { id: 'delete', label: 'Delete', onSelect: vi.fn(), ...overrides.delete },
]

describe('Menu', () => {
  it('starts closed (the menu list is not in the DOM)', () => {
    // Arrange
    // Act
    render(<Menu items={buildItems()} label="Row actions" />)

    // Assert
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('button', { name: 'Row actions' }).getAttribute('aria-expanded')).toBe(
      'false'
    )
  })

  it('opens on trigger click and points aria-controls at the menu list', async () => {
    // Arrange
    const user = userEvent.setup()
    render(<Menu items={buildItems()} label="Row actions" />)

    // Act
    await user.click(screen.getByRole('button', { name: 'Row actions' }))

    // Assert
    const menu = screen.getByRole('menu')
    const trigger = screen.getByRole('button', { name: 'Row actions' })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(trigger.getAttribute('aria-controls')).toBe(menu.id)
    expect(menu.id).toBeTruthy()
  })

  it('moves focus to the first menuitem when it opens', async () => {
    // Arrange
    const user = userEvent.setup()
    render(<Menu items={buildItems()} label="Row actions" />)

    // Act
    await user.click(screen.getByRole('button', { name: 'Row actions' }))

    // Assert
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Rename' }))
  })

  it('calls onSelect of the activated item and closes the menu', async () => {
    // Arrange
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(
      <Menu
        items={[
          { id: 'rename', label: 'Rename', onSelect },
          { id: 'archive', label: 'Archive', onSelect: vi.fn() },
        ]}
        label="Row actions"
      />
    )
    await user.click(screen.getByRole('button', { name: 'Row actions' }))

    // Act
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }))

    // Assert
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('skips disabled items when navigating with ArrowDown', async () => {
    // Arrange
    const user = userEvent.setup()
    render(
      <Menu
        items={[
          { id: 'rename', label: 'Rename', onSelect: vi.fn() },
          { id: 'archive', label: 'Archive', disabled: true },
          { id: 'delete', label: 'Delete', onSelect: vi.fn() },
        ]}
        label="Row actions"
      />
    )
    await user.click(screen.getByRole('button', { name: 'Row actions' }))

    // Act
    await user.keyboard('{ArrowDown}')

    // Assert — Archive is disabled, so focus jumps to Delete
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Delete' }))
  })

  it('Home and End jump focus to the first and last enabled items', async () => {
    // Arrange
    const user = userEvent.setup()
    render(
      <Menu
        items={[
          { id: 'rename', label: 'Rename', onSelect: vi.fn() },
          { id: 'archive', label: 'Archive', onSelect: vi.fn() },
          { id: 'delete', label: 'Delete', disabled: true },
        ]}
        label="Row actions"
      />
    )
    await user.click(screen.getByRole('button', { name: 'Row actions' }))

    // Act
    await user.keyboard('{End}')

    // Assert — Delete is disabled, so End targets Archive (last enabled)
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Archive' }))

    // Act
    await user.keyboard('{Home}')

    // Assert
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Rename' }))
  })

  it('Escape closes the menu and restores focus to the trigger', async () => {
    // Arrange
    const user = userEvent.setup()
    render(<Menu items={buildItems()} label="Row actions" />)
    const trigger = screen.getByRole('button', { name: 'Row actions' })
    await user.click(trigger)

    // Act
    await user.keyboard('{Escape}')

    // Assert
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('does not put a disabled menuitem in the tab order when all items are disabled', async () => {
    // Arrange
    const user = userEvent.setup()
    render(
      <Menu
        items={[
          { id: 'rename', label: 'Rename', disabled: true },
          { id: 'archive', label: 'Archive', disabled: true },
        ]}
        label="Row actions"
      />
    )

    // Act
    await user.click(screen.getByRole('button', { name: 'Row actions' }))

    // Assert — every rendered menuitem has tabIndex=-1, so no disabled item
    // claims the tab stop.
    for (const menuitem of screen.getAllByRole('menuitem')) {
      expect(menuitem.getAttribute('tabindex')).toBe('-1')
    }
  })

  it('a click outside the root closes the menu', async () => {
    // Arrange
    const outside = document.createElement('div')
    outside.textContent = 'outside'
    document.body.appendChild(outside)
    const user = userEvent.setup()
    render(<Menu items={buildItems()} label="Row actions" />)
    await user.click(screen.getByRole('button', { name: 'Row actions' }))
    expect(screen.getByRole('menu')).toBeTruthy()

    // Act
    await user.pointer({ keys: '[MouseLeft]', target: outside })

    // Assert
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
