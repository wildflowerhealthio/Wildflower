import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { CheckboxGroup, type CheckboxGroupItem } from './checkbox-group.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

type Interactions = 'c' | 'r' | 'u' | 'd' | 's'
type ReadWritePermissions = 'read' | 'write'

const fiveItems: CheckboxGroupItem<Interactions>[] = [
  { id: 'c', label: 'Create', code: 'c', checked: false, locked: false, disabled: false },
  {
    id: 'r',
    label: 'Read',
    code: 'r',
    checked: true,
    locked: true,
    disabled: false,
    reason: 'Required',
  },
  {
    id: 'u',
    label: 'Update',
    code: 'u',
    checked: false,
    locked: false,
    disabled: true,
    reason: 'Not applicable',
  },
  { id: 'd', label: 'Destroy', code: 'd', checked: false, locked: false, disabled: false },
  { id: 's', label: 'Search', code: 's', checked: true, locked: false, disabled: false },
]

const twoItems: CheckboxGroupItem<ReadWritePermissions>[] = [
  { id: 'read', label: 'Read', code: 'read', checked: true, locked: false, disabled: false },
  { id: 'write', label: 'Write', code: 'write', checked: false, locked: false, disabled: false },
]

describe('CheckboxGroup', () => {
  it('renders one checkbox per item', () => {
    render(<CheckboxGroup items={fiveItems} onToggle={vi.fn()} ariaLabel="Group" />)
    expect(screen.getAllByRole('checkbox')).toHaveLength(5)
  }, 15_000)

  it('reflects each item checked state', () => {
    render(<CheckboxGroup items={twoItems} onToggle={vi.fn()} ariaLabel="Group" />)
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Read/ }).checked).toBe(true)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Write/ }).checked).toBe(false)
  })

  it('toggles an editable item by id', async () => {
    const onToggle = vi.fn()
    const user = userEvent.setup()
    render(<CheckboxGroup items={twoItems} onToggle={onToggle} ariaLabel="Group" />)

    await user.click(screen.getByRole('checkbox', { name: /Write/ }))

    expect(onToggle).toHaveBeenCalledWith('write')
  })

  it('does not toggle a locked or disabled item', async () => {
    const onToggle = vi.fn()
    const user = userEvent.setup()
    render(<CheckboxGroup items={fiveItems} onToggle={onToggle} ariaLabel="Group" />)

    await user.click(screen.getByRole('checkbox', { name: /Read/ })) // locked
    await user.click(screen.getByRole('checkbox', { name: /Update/ })) // disabled

    expect(onToggle).not.toHaveBeenCalled()
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Read/ }).disabled).toBe(true)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Update/ }).disabled).toBe(true)
  })
})
