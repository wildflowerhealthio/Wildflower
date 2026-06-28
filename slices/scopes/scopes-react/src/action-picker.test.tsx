import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { ActionPicker, type PickerItem } from './action-picker.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

// v2 CRUDS items.
const letters: PickerItem[] = [
  { id: 'c', label: 'Create', code: 'c', checked: false, locked: false, disabled: false },
  {
    id: 'r',
    label: 'Read',
    code: 'r',
    checked: true,
    locked: true,
    disabled: false,
    reason: 'Required by the app',
  },
  {
    id: 'u',
    label: 'Update',
    code: 'u',
    checked: false,
    locked: false,
    disabled: true,
    reason: 'Not requested',
  },
  { id: 'd', label: 'Destroy', code: 'd', checked: false, locked: false, disabled: false },
  { id: 's', label: 'Search', code: 's', checked: true, locked: false, disabled: false },
]

// v1 Read/Write items — the same component, two rows.
const words: PickerItem[] = [
  { id: 'read', label: 'Read', code: 'read', checked: true, locked: false, disabled: false },
  { id: 'write', label: 'Write', code: 'write', checked: false, locked: false, disabled: false },
]

describe('ActionPicker', () => {
  it('renders one checkbox per item (CRUDS for v2)', () => {
    render(<ActionPicker items={letters} onToggle={vi.fn()} ariaLabel="Actions" />)
    expect(screen.getAllByRole('checkbox')).toHaveLength(5)
  }, 15_000)

  it('renders the v1 Read/Write multiselect from two items', () => {
    render(<ActionPicker items={words} onToggle={vi.fn()} ariaLabel="Access" />)
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Read/ }).checked).toBe(true)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Write/ }).checked).toBe(false)
  })

  it('toggles an editable item by id', async () => {
    const onToggle = vi.fn()
    const user = userEvent.setup()
    render(<ActionPicker items={words} onToggle={onToggle} ariaLabel="Access" />)

    await user.click(screen.getByRole('checkbox', { name: /Write/ }))

    expect(onToggle).toHaveBeenCalledWith('write')
  })

  it('does not toggle a locked or disabled item', async () => {
    const onToggle = vi.fn()
    const user = userEvent.setup()
    render(<ActionPicker items={letters} onToggle={onToggle} ariaLabel="Actions" />)

    await user.click(screen.getByRole('checkbox', { name: /Read/ })) // locked
    await user.click(screen.getByRole('checkbox', { name: /Update/ })) // disabled

    expect(onToggle).not.toHaveBeenCalled()
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Read/ }).disabled).toBe(true)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Update/ }).disabled).toBe(true)
  })
})
