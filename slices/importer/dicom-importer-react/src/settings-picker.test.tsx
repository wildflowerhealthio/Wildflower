import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DicomSettings } from 'dicom-importer-core'
import { DateTime, Option } from 'effect'
import { type JSX, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { DicomSettingsPicker, UNKNOWN_ZONE_MESSAGE } from './settings-picker.tsx'
import { NORTH_AMERICAN_TIME_ZONES, suggestedTimeZones } from './time-zones.ts'

const ZONE_FIELD = 'Equipment time zone'

/**
 * The picker under a parent that owns the settings, the way the shell does —
 * so a commit round-trips back in as a prop and the test sees what the
 * reviewer would.
 */
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

  it('reports one committed zone for a typed name, not one per keystroke', async () => {
    const changes: DicomSettings[] = []
    render(<Harness initial={{ timeZone: 'UTC' }} onChange={(s) => changes.push(s)} />)
    const input = screen.getByLabelText<HTMLInputElement>(ZONE_FIELD)

    await userEvent.clear(input)
    await userEvent.type(input, 'America/Vancouver')

    // Every keystroke shows immediately — the field is never behind the typist.
    expect(input.value).toBe('America/Vancouver')
    // Each commit re-decodes the whole batch, so the intermediate prefixes
    // ('A', 'Am', 'Ame', …) must not reach the shell.
    await waitFor(() => {
      expect(changes).toEqual([{ timeZone: 'America/Vancouver' }])
    })
  })

  it('never commits a prefix the runtime cannot resolve as a zone', async () => {
    const changes: DicomSettings[] = []
    render(<Harness initial={{ timeZone: 'UTC' }} onChange={(s) => changes.push(s)} />)
    const input = screen.getByLabelText<HTMLInputElement>(ZONE_FIELD)

    await userEvent.clear(input)
    await userEvent.type(input, 'America/Toron')
    await userEvent.tab()

    // A half-typed name would fail `decodeDicom`'s zone check and flip every
    // DICOM file to "could not be read"; it is flagged inline instead.
    expect(screen.getByRole('alert').textContent).toBe(UNKNOWN_ZONE_MESSAGE)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(changes).toEqual([])
  })

  it('flushes the pending zone immediately on blur', async () => {
    const onChange = vi.fn()
    render(<Harness initial={{ timeZone: 'UTC' }} onChange={onChange} />)
    const input = screen.getByLabelText<HTMLInputElement>(ZONE_FIELD)

    await userEvent.clear(input)
    await userEvent.type(input, 'America/Halifax')
    await userEvent.tab()

    expect(onChange).toHaveBeenCalledWith({ timeZone: 'America/Halifax' })
  })

  it('keeps the field focused and the caret placed while typing', async () => {
    render(<Harness initial={{ timeZone: 'UTC' }} onChange={() => {}} />)
    const input = screen.getByLabelText<HTMLInputElement>(ZONE_FIELD)

    await userEvent.clear(input)
    await userEvent.type(input, 'America/Denver')

    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe('America/Denver'.length)
  })

  it('re-seeds from a settings change that did not come from this field', async () => {
    const Outer = (): JSX.Element => {
      const [settings, setSettings] = useState<DicomSettings>({ timeZone: 'UTC' })
      return (
        <>
          <button type="button" onClick={() => setSettings({ timeZone: 'America/Regina' })}>
            reset
          </button>
          <DicomSettingsPicker settings={settings} onChange={setSettings} />
        </>
      )
    }
    render(<Outer />)

    await userEvent.click(screen.getByRole('button', { name: 'reset' }))

    expect(screen.getByLabelText<HTMLInputElement>(ZONE_FIELD).value).toBe('America/Regina')
  })

  it('clears the invalid flag once the name is complete', async () => {
    render(<Harness initial={{ timeZone: 'Mars/Olympus' }} onChange={() => {}} />)
    const input = screen.getByLabelText<HTMLInputElement>(ZONE_FIELD)

    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('alert').textContent).toBe(UNKNOWN_ZONE_MESSAGE)

    await userEvent.clear(input)
    await userEvent.type(input, 'America/Vancouver')

    expect(input.getAttribute('aria-invalid')).toBe('false')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('offers every suggestion as a datalist option', () => {
    render(<Harness initial={{ timeZone: 'UTC' }} onChange={() => {}} />)
    const input = screen.getByLabelText<HTMLInputElement>(ZONE_FIELD)
    const list = document.getElementById(input.getAttribute('list') ?? '')

    expect(list).not.toBeNull()
    const offered = [...(list?.querySelectorAll('option') ?? [])].map((option) => option.value)
    expect(offered).toEqual([...suggestedTimeZones()])
  })
})

describe('suggestedTimeZones', () => {
  it('offers only zones the runtime can actually resolve', () => {
    for (const zone of suggestedTimeZones()) {
      expect(Option.isSome(DateTime.zoneMakeNamed(zone))).toBe(true)
    }
  })

  it('covers the North American zones with no duplicate', () => {
    const suggested = suggestedTimeZones()
    expect(new Set(suggested).size).toBe(suggested.length)
    for (const zone of NORTH_AMERICAN_TIME_ZONES) expect(suggested).toContain(zone)
  })

  it('includes the zones that do not observe DST, the ones most easily got wrong', () => {
    expect(NORTH_AMERICAN_TIME_ZONES).toContain('America/Phoenix')
    expect(NORTH_AMERICAN_TIME_ZONES).toContain('America/Regina')
  })
})
