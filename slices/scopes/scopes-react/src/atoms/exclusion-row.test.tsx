import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { ExclusionRow } from './exclusion-row.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ExclusionRow', () => {
  it('excluded + allowable shows "+ Allow"', async () => {
    const onToggle = vi.fn()
    const user = userEvent.setup()
    render(
      <ExclusionRow
        label="Other health records"
        allowed={false}
        allowable={true}
        onToggle={onToggle}
      />
    )

    const button = screen.getByRole('button', { name: '+ Allow' })
    await user.click(button)
    expect(onToggle).toHaveBeenCalledTimes(1)
  }, 15_000)

  it('excluded + not allowable (request mode) shows no action', () => {
    render(
      <ExclusionRow
        label="Account & admin tools"
        allowed={false}
        allowable={false}
        onToggle={vi.fn()}
      />
    )
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('allowed shows "Remove"', async () => {
    const onToggle = vi.fn()
    const user = userEvent.setup()
    render(
      <ExclusionRow
        label="Other health records"
        allowed={true}
        allowable={true}
        onToggle={onToggle}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})
