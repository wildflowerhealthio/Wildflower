import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { defaultHarSettings, fhirSources } from 'har-importer-core'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { HarSettingsPicker } from './settings-picker.tsx'

afterEach(cleanup)

describe('HarSettingsPicker', () => {
  it('should render one labelled group per source with a checkbox per kind, all on by default', () => {
    render(<HarSettingsPicker settings={defaultHarSettings} onChange={() => undefined} />)

    for (const source of fhirSources) {
      expect(screen.getByRole('group', { name: source.display.title })).toBeDefined()
    }
    const kindCount = fhirSources.reduce((count, source) => count + source.responseKinds.length, 0)
    const checkboxes = screen.getAllByRole<HTMLInputElement>('checkbox')
    expect(checkboxes).toHaveLength(kindCount)
    for (const checkbox of checkboxes) {
      expect(checkbox.checked).toBe(true)
    }
  })

  it('should label each kind without the conventional ResponseKind suffix', () => {
    render(<HarSettingsPicker settings={defaultHarSettings} onChange={() => undefined} />)

    expect(screen.getByRole('checkbox', { name: 'Patient' })).toBeDefined()
    expect(screen.queryByRole('checkbox', { name: 'PatientResponseKind' })).toBeNull()
  })

  it('should report a turned-off kind by adding its full name to disabledKinds', async () => {
    const onChange = vi.fn()
    render(<HarSettingsPicker settings={defaultHarSettings} onChange={onChange} />)

    await userEvent.click(screen.getByRole('checkbox', { name: 'Patient' }))

    expect(onChange).toHaveBeenCalledWith({ disabledKinds: ['PatientResponseKind'] })
  })

  it('should render a disabled kind unchecked and re-enable it on toggle, preserving the others', async () => {
    const onChange = vi.fn()
    const settings = { disabledKinds: ['PatientResponseKind', 'ObservationResponseKind'] }
    render(<HarSettingsPicker settings={settings} onChange={onChange} />)

    const patient = screen.getByRole<HTMLInputElement>('checkbox', { name: 'Patient' })
    expect(patient.checked).toBe(false)

    await userEvent.click(patient)

    expect(onChange).toHaveBeenCalledWith({ disabledKinds: ['ObservationResponseKind'] })
  })
})
