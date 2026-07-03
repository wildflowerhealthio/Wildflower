import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { PermissionPicker, type PickerItem } from './permission-picker.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

// The picker is generic over its permission style — the same component renders v2
// interaction cells and v1 Read/Write words, supplied as data.
const interactionItems: PickerItem[] = [
  { id: 'c', name: 'Create', code: 'c', state: 'off', reason: null },
  { id: 'r', name: 'Read', code: 'r', state: 'locked', reason: 'Required by the app' },
  { id: 'u', name: 'Update', code: 'u', state: 'disabled', reason: 'Not requested' },
  { id: 's', name: 'Search', code: 's', state: 'on', reason: null },
]

const wordItems: PickerItem[] = [
  { id: 'read', name: 'Read', code: 'read', state: 'on', reason: null },
  { id: 'write', name: 'Write', code: 'write', state: 'off', reason: null },
]

describe('PermissionPicker — interaction style (v2)', () => {
  it('renders one checkbox per item, reflecting its cell state', () => {
    render(<PermissionPicker items={interactionItems} onToggle={vi.fn()} ariaLabel="Permissions" />)
    expect(screen.getAllByRole('checkbox')).toHaveLength(4)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Read/ }).checked).toBe(true)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Create/ }).checked).toBe(false)
  }, 15_000)

  it('toggles an editable item by its id', async () => {
    const onToggle = vi.fn()
    const user = userEvent.setup()
    render(
      <PermissionPicker items={interactionItems} onToggle={onToggle} ariaLabel="Permissions" />
    )

    await user.click(screen.getByRole('checkbox', { name: /Create/ }))

    expect(onToggle).toHaveBeenCalledWith('c')
  })

  it('does not toggle a locked or disabled item', async () => {
    const onToggle = vi.fn()
    const user = userEvent.setup()
    render(
      <PermissionPicker items={interactionItems} onToggle={onToggle} ariaLabel="Permissions" />
    )

    await user.click(screen.getByRole('checkbox', { name: /Read/ })) // locked
    await user.click(screen.getByRole('checkbox', { name: /Update/ })) // disabled

    expect(onToggle).not.toHaveBeenCalled()
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Read/ }).disabled).toBe(true)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Update/ }).disabled).toBe(true)
  })
})

describe('PermissionPicker — v1 Read/Write style', () => {
  it('renders a Read and a Write checkbox reflecting their state', () => {
    render(<PermissionPicker items={wordItems} onToggle={vi.fn()} ariaLabel="Permissions" />)
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Read/ }).checked).toBe(true)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Write/ }).checked).toBe(false)
  }, 15_000)

  it('toggles an editable item by its id', async () => {
    const onToggle = vi.fn()
    const user = userEvent.setup()
    render(<PermissionPicker items={wordItems} onToggle={onToggle} ariaLabel="Permissions" />)

    await user.click(screen.getByRole('checkbox', { name: /Write/ }))

    expect(onToggle).toHaveBeenCalledWith('write')
  })

  it('does not toggle a locked item', async () => {
    const onToggle = vi.fn()
    const user = userEvent.setup()
    const locked: PickerItem[] = [
      {
        id: 'read',
        name: 'Read',
        code: 'read',
        state: 'locked',
        reason: 'Granted by ✶ All record types',
      },
      { id: 'write', name: 'Write', code: 'write', state: 'off', reason: null },
    ]
    render(<PermissionPicker items={locked} onToggle={onToggle} ariaLabel="Permissions" />)

    await user.click(screen.getByRole('checkbox', { name: /Read/ }))

    expect(onToggle).not.toHaveBeenCalled()
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Read/ }).disabled).toBe(true)
  })
})
