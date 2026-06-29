import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import type { PickerItem } from '../molecules/action-picker.tsx'
import { PermissionStatement } from './permission-statement.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

const items: PickerItem[] = [
  { id: 'r', label: 'Read', code: 'r', checked: true, locked: false, disabled: false },
]

describe('PermissionStatement', () => {
  it('reads the verb token and expands the editor when open', () => {
    const { rerender } = render(
      <PermissionStatement
        subjectPhrase="Fitbit Sync can"
        connector="your"
        verbText="Read · Search"
        resourceLabel="Observation"
        items={items}
        onToggleItem={vi.fn()}
        open={false}
        onToggleOpen={vi.fn()}
        removable={true}
        onRemove={vi.fn()}
      />
    )
    expect(
      screen.getByRole('button', { name: /Read · Search/ }).getAttribute('aria-expanded')
    ).toBe('false')
    expect(screen.queryByRole('group')).toBeNull()

    rerender(
      <PermissionStatement
        subjectPhrase="Fitbit Sync can"
        connector="your"
        verbText="Read · Search"
        resourceLabel="Observation"
        items={items}
        onToggleItem={vi.fn()}
        open={true}
        onToggleOpen={vi.fn()}
        removable={true}
        onRemove={vi.fn()}
      />
    )
    expect(screen.getByRole('group')).toBeDefined()
  }, 15_000)

  it('fires onToggleOpen when the verb token is clicked', async () => {
    const onToggleOpen = vi.fn()
    const user = userEvent.setup()
    render(
      <PermissionStatement
        subjectPhrase="It can also"
        verbText="Create"
        resourceLabel="Condition"
        items={items}
        onToggleItem={vi.fn()}
        open={false}
        onToggleOpen={onToggleOpen}
      />
    )

    await user.click(screen.getByRole('button', { name: /Create/ }))
    expect(onToggleOpen).toHaveBeenCalledTimes(1)
  })

  it('shows a Required badge instead of Remove for required scopes', () => {
    render(
      <PermissionStatement
        subjectPhrase="Fitbit Sync can"
        verbText="Read"
        resourceLabel="Patient demographics"
        items={items}
        onToggleItem={vi.fn()}
        open={false}
        onToggleOpen={vi.fn()}
        required={true}
      />
    )
    expect(screen.getByText('Required')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
  })
})
