import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { PermissionStatement } from './permission-statement.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

const editor = <div role="group" aria-label="Edit access" />

describe('PermissionStatement', () => {
  it('reads the verb token and reveals the editor only when open', () => {
    const { rerender } = render(
      <PermissionStatement
        subjectPhrase="Fitbit Sync can"
        connector="your"
        verbText="Read · Search"
        resourceLabel="Observation"
        open={false}
        onToggleOpen={vi.fn()}
        removable={true}
        onRemove={vi.fn()}
      >
        {editor}
      </PermissionStatement>
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
        open={true}
        onToggleOpen={vi.fn()}
        removable={true}
        onRemove={vi.fn()}
      >
        {editor}
      </PermissionStatement>
    )
    expect(screen.getByRole('group')).toBeDefined()
  }, 15_000)

  it('peeks the editor on hover and puts it away on leave, without touching open', async () => {
    const onToggleOpen = vi.fn()
    const user = userEvent.setup()
    render(
      <PermissionStatement
        subjectPhrase="Fitbit Sync can"
        verbText="Read · Search"
        resourceLabel="Observation"
        open={false}
        onToggleOpen={onToggleOpen}
      >
        {editor}
      </PermissionStatement>
    )

    await user.hover(screen.getByRole('button', { name: /Read · Search/ }))
    expect(screen.getByRole('group')).toBeDefined()

    await user.unhover(screen.getByRole('button', { name: /Read · Search/ }))
    expect(screen.queryByRole('group')).toBeNull()
    // Hover is a peek — the click-pinned state was never toggled.
    expect(onToggleOpen).not.toHaveBeenCalled()
  })

  it('fires onToggleOpen when the verb token is clicked', async () => {
    const onToggleOpen = vi.fn()
    const user = userEvent.setup()
    render(
      <PermissionStatement
        subjectPhrase="It can also"
        verbText="Create"
        resourceLabel="Condition"
        open={false}
        onToggleOpen={onToggleOpen}
      >
        {editor}
      </PermissionStatement>
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
        open={false}
        onToggleOpen={vi.fn()}
        required={true}
      >
        {editor}
      </PermissionStatement>
    )
    expect(screen.getByText('Required')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
  })
})
