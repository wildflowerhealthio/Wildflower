import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { FlagToggleRow } from './flag-toggle-row.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('FlagToggleRow', () => {
  it('renders the consent copy and scope code under the switch role', () => {
    render(
      <FlagToggleRow label="Confirm who you are" code="openid" checked={true} onChange={vi.fn()} />
    )
    expect(
      screen.getByRole<HTMLInputElement>('switch', { name: /Confirm who you are/ }).checked
    ).toBe(true)
    expect(screen.getByText('openid')).toBeDefined()
  }, 15_000)

  it('fires onChange when toggled', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <FlagToggleRow
        label="Stay connected"
        code="offline_access"
        checked={false}
        onChange={onChange}
      />
    )

    await user.click(screen.getByRole('switch', { name: /Stay connected/ }))

    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('is non-interactive when disabled (not requested)', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<FlagToggleRow label="Profile" code="profile" checked={false} disabled={true} />)

    await user.click(screen.getByRole('switch', { name: /Profile/ }))

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole<HTMLInputElement>('switch', { name: /Profile/ }).disabled).toBe(true)
  })
})
