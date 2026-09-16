import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DicomSettings } from 'dicom-importer-core'
import { type JSX, useState } from 'react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import {
  DicomSettingsPicker,
  SUGGESTED_TIME_ZONES,
  UNKNOWN_ZONE_MESSAGE,
} from './settings-picker.tsx'

const Harness = ({
  initial,
  onChange,
}: {
  readonly initial: DicomSettings
  readonly onChange: (settings: DicomSettings) => void
}): JSX.Element => {
  const [settings, setSettings] = useState(initial)
  return (
    <DicomSettingsPicker
      settings={settings}
      onChange={(next) => {
        setSettings(next)
        onChange(next)
      }}
    />
  )
}

describe('DicomSettingsPicker', () => {
  afterEach(cleanup)

  it('shows the current zone and reports every keystroke up verbatim', async () => {
    const changes: DicomSettings[] = []
    render(<Harness initial={{ timeZone: 'America/Toronto' }} onChange={(s) => changes.push(s)} />)
    const input = screen.getByLabelText<HTMLInputElement>('Equipment time zone')

    expect(input.value).toBe('America/Toronto')
    await userEvent.clear(input)
    await userEvent.type(input, 'UTC')

    expect(changes.at(-1)).toEqual({ timeZone: 'UTC' })
    expect(input.value).toBe('UTC')
    expect(input.getAttribute('aria-invalid')).toBe('false')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('flags a zone the runtime does not know, and clears the flag once it is fixed', async () => {
    render(<Harness initial={{ timeZone: 'Mars/Olympus' }} onChange={() => {}} />)
    const input = screen.getByLabelText<HTMLInputElement>('Equipment time zone')

    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('alert').textContent).toBe(UNKNOWN_ZONE_MESSAGE)

    await userEvent.clear(input)
    await userEvent.type(input, 'America/Vancouver')

    expect(input.getAttribute('aria-invalid')).toBe('false')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('suggests UTC and this runtime’s own zone, with no duplicate', () => {
    expect(SUGGESTED_TIME_ZONES).toContain('UTC')
    expect(new Set(SUGGESTED_TIME_ZONES).size).toBe(SUGGESTED_TIME_ZONES.length)
  })
})
