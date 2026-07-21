import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { ProvincePicker } from './province-picker.tsx'

afterEach(cleanup)

describe('ProvincePicker', () => {
  test('renders every province and reflects the selected value', () => {
    render(<ProvincePicker value="ON" onChange={() => {}} />)
    expect(screen.getAllByRole('option')).toHaveLength(13)
    // The select's current display value is the selected province's full name.
    expect(screen.getByDisplayValue('Ontario')).toBeDefined()
  })

  test('calls onChange with the chosen province code', () => {
    const onChange = vi.fn()
    render(<ProvincePicker value="ON" onChange={onChange} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'BC' } })
    expect(onChange).toHaveBeenCalledWith('BC')
  })
})
