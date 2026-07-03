import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { CheckboxGroup, type CheckboxGroupItem } from './checkbox-group.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

type Item = 'one' | 'two' | 'three' | 'four' | 'five'
type Pair = 'first' | 'second'

const fiveItems: CheckboxGroupItem<Item>[] = [
  { id: 'one', label: 'One', mono: '1', checked: false, locked: false, disabled: false },
  {
    id: 'two',
    label: 'Two',
    mono: '2',
    checked: true,
    locked: true,
    disabled: false,
    reason: 'Required',
  },
  {
    id: 'three',
    label: 'Three',
    mono: '3',
    checked: false,
    locked: false,
    disabled: true,
    reason: 'Not applicable',
  },
  { id: 'four', label: 'Four', mono: '4', checked: false, locked: false, disabled: false },
  { id: 'five', label: 'Five', mono: '5', checked: true, locked: false, disabled: false },
]

const twoItems: CheckboxGroupItem<Pair>[] = [
  { id: 'first', label: 'First', mono: '1st', checked: true, locked: false, disabled: false },
  { id: 'second', label: 'Second', mono: '2nd', checked: false, locked: false, disabled: false },
]

describe('CheckboxGroup', () => {
  it('renders one checkbox per item', () => {
    render(<CheckboxGroup items={fiveItems} onToggle={vi.fn()} ariaLabel="Group" />)
    expect(screen.getAllByRole('checkbox')).toHaveLength(5)
  }, 15_000)

  it('reflects each item checked state', () => {
    render(<CheckboxGroup items={twoItems} onToggle={vi.fn()} ariaLabel="Group" />)
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /First/ }).checked).toBe(true)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Second/ }).checked).toBe(false)
  })

  it('toggles an editable item by id', async () => {
    const onToggle = vi.fn()
    const user = userEvent.setup()
    render(<CheckboxGroup items={twoItems} onToggle={onToggle} ariaLabel="Group" />)

    await user.click(screen.getByRole('checkbox', { name: /Second/ }))

    expect(onToggle).toHaveBeenCalledWith('second')
  })

  it('does not toggle a locked or disabled item', async () => {
    const onToggle = vi.fn()
    const user = userEvent.setup()
    render(<CheckboxGroup items={fiveItems} onToggle={onToggle} ariaLabel="Group" />)

    await user.click(screen.getByRole('checkbox', { name: /Two/ })) // locked
    await user.click(screen.getByRole('checkbox', { name: /Three/ })) // disabled

    expect(onToggle).not.toHaveBeenCalled()
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Two/ }).disabled).toBe(true)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Three/ }).disabled).toBe(true)
  })
})
