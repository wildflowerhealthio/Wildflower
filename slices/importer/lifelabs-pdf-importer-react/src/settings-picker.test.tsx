import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { LifeLabsPdfSettings } from '@wildflowerhealthio/lifelabs-pdf-importer-core'
import { type JSX, useState } from 'react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { LifeLabsPdfSettingsPicker, UNKNOWN_ZONE_MESSAGE } from './settings-picker.tsx'

const Harness = ({
  initial,
  onChange,
}: {
  readonly initial: LifeLabsPdfSettings
  readonly onChange: (settings: LifeLabsPdfSettings) => void
}): JSX.Element => {
  const [settings, setSettings] = useState(initial)
  return (
    <LifeLabsPdfSettingsPicker
      settings={settings}
      onChange={(next) => {
        setSettings(next)
        onChange(next)
      }}
    />
  )
}

describe('LifeLabsPdfSettingsPicker', () => {
  afterEach(cleanup)

  it('shows the current zone and reports every keystroke up verbatim', async () => {
    const changes: LifeLabsPdfSettings[] = []
    render(
      <Harness
        initial={{ timeZone: 'America/Toronto', healthCardProvince: 'ON' }}
        onChange={(s) => changes.push(s)}
      />
    )
    const input = screen.getByLabelText<HTMLInputElement>('Report time zone')

    expect(input.value).toBe('America/Toronto')
    await userEvent.clear(input)
    await userEvent.type(input, 'UTC')

    expect(changes.at(-1)).toEqual({ timeZone: 'UTC', healthCardProvince: 'ON' })
    expect(input.value).toBe('UTC')
    expect(input.getAttribute('aria-invalid')).toBe('false')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('flags a zone the runtime does not know, and clears the flag once it is fixed', async () => {
    render(
      <Harness
        initial={{ timeZone: 'Mars/Olympus', healthCardProvince: 'ON' }}
        onChange={() => {}}
      />
    )
    const input = screen.getByLabelText<HTMLInputElement>('Report time zone')

    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('alert').textContent).toBe(UNKNOWN_ZONE_MESSAGE)

    await userEvent.clear(input)
    await userEvent.type(input, 'America/Vancouver')

    expect(input.getAttribute('aria-invalid')).toBe('false')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the current health card province and reports a change of it up', async () => {
    const changes: LifeLabsPdfSettings[] = []
    render(
      <Harness
        initial={{ timeZone: 'America/Vancouver', healthCardProvince: 'ON' }}
        onChange={(s) => changes.push(s)}
      />
    )
    const select = screen.getByLabelText<HTMLSelectElement>('Health card province')

    expect(select.value).toBe('ON')
    expect([...select.options].map((option) => option.text)).toEqual([
      'Ontario',
      'British Columbia',
      'Other province',
    ])
    await userEvent.selectOptions(select, 'British Columbia')
    await userEvent.selectOptions(select, 'Other province')

    expect(changes).toEqual([
      { timeZone: 'America/Vancouver', healthCardProvince: 'BC' },
      { timeZone: 'America/Vancouver', healthCardProvince: 'Other' },
    ])
    expect(select.value).toBe('Other')
  })
})
