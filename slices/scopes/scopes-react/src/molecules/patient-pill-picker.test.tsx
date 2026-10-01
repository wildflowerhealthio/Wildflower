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

  it('shows the "Select a Patient" call to action when nothing is selected', () => {
    render(<PatientPillPicker patients={patients} value={null} onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: /Select a Patient/ })).toBeDefined()
  })

  it('picking a patient reports the id and closes the list', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<PatientPillPicker patients={patients} value={null} onChange={onChange} />)

    await user.click(screen.getByRole('button', { name: /Select a Patient/ }))
    await user.click(screen.getByRole('option', { name: /Sam Reyes/ }))

    expect(onChange).toHaveBeenCalledWith('pat-2')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('offers no "No patient" option without onChooseNoPatient — a patient must be chosen', async () => {
    const user = userEvent.setup()
    render(<PatientPillPicker patients={patients} value={null} onChange={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /Select a Patient/ }))

    expect(screen.queryByRole('option', { name: /No patient/ })).toBeNull()
    // Only the real patients are offered.
    expect(screen.getAllByRole('option')).toHaveLength(patients.length)
  })

  it('with onChooseNoPatient, leads with a "No patient" option shown while nothing is selected', async () => {
    const onChooseNoPatient = vi.fn()
    const user = userEvent.setup()
    render(
      <PatientPillPicker
        patients={patients}
        value={null}
        onChange={vi.fn()}
        onChooseNoPatient={onChooseNoPatient}
      />
    )

    await user.click(screen.getByRole('button', { name: /No patient/ }))

    const options = screen.getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([
      'No patient',
      'Jordan Leepat-1',
      'Sam Reyespat-2',
    ])
    expect(options[0]?.getAttribute('aria-selected')).toBe('true')
  })

  it('picking "No patient" reports it and closes the list', async () => {
    const onChange = vi.fn()
    const onChooseNoPatient = vi.fn()
    const user = userEvent.setup()
    render(
      <PatientPillPicker
        patients={patients}
        value="pat-1"
        onChange={onChange}
        onChooseNoPatient={onChooseNoPatient}
      />
    )

    await user.click(screen.getByRole('button', { name: /Jordan Lee/ }))
    await user.click(screen.getByRole('option', { name: /No patient/ }))

    expect(onChooseNoPatient).toHaveBeenCalledTimes(1)
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).toBeNull()
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
