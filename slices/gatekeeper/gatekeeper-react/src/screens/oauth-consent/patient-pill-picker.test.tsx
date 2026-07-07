import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { PatientPillPicker } from './patient-pill-picker.tsx'
import type { PatientOption } from './patient-pill-picker.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

const patients: readonly PatientOption[] = [
  { id: 'pat-1', displayName: 'Jordan Lee' },
  { id: 'pat-2', displayName: 'Sam Reyes' },
]

describe('PatientPillPicker', () => {
  it('shows the selected patient on the pill and reveals the list on demand', async () => {
    const user = userEvent.setup()
    render(<PatientPillPicker patients={patients} value="pat-1" onChange={vi.fn()} />)

    const pill = screen.getByRole('button', { name: /Jordan Lee/ })
    expect(pill.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('listbox')).toBeNull()

    await user.click(pill)

    expect(screen.getByRole('listbox')).toBeDefined()
    expect(screen.getByRole('option', { name: /Jordan Lee/ }).getAttribute('aria-selected')).toBe(
      'true'
    )
  }, 15_000)

  it('falls back to "No patient context" when nothing is selected', () => {
    render(<PatientPillPicker patients={patients} value={null} onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: /No patient context/ })).toBeDefined()
  })

  it('picking a patient reports the id and closes the list', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<PatientPillPicker patients={patients} value={null} onChange={onChange} />)

    await user.click(screen.getByRole('button', { name: /No patient context/ }))
    await user.click(screen.getByRole('option', { name: /Sam Reyes/ }))

    expect(onChange).toHaveBeenCalledWith('pat-2')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('picking "No patient context" reports null', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<PatientPillPicker patients={patients} value="pat-1" onChange={onChange} />)

    await user.click(screen.getByRole('button', { name: /Jordan Lee/ }))
    await user.click(screen.getByRole('option', { name: /No patient context/ }))

    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('Escape closes the list without changing the selection', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<PatientPillPicker patients={patients} value="pat-1" onChange={onChange} />)

    await user.click(screen.getByRole('button', { name: /Jordan Lee/ }))
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('listbox')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })
})
