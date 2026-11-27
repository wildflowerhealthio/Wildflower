import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { DicomSettings } from '@wildflowerhealthio/dicom-importer-core'
import { TIME_ZONE_COMMIT_DELAY_MS } from '@wildflowerhealthio/react-tundraish'
import { DateTime, Option } from 'effect'
import { type JSX, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { DicomSettingsPicker, NORTH_AMERICAN_TIME_ZONES, suggestedTimeZones } from './index.ts'

const ZONE_FIELD = 'Equipment time zone'

/**
 * The picker under a parent that owns the settings, the way the shell does —
 * so a report round-trips back in as a prop and the test sees what the
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

/** Type `text` into the field one keystroke at a time, from empty. */
const typeZone = (input: HTMLInputElement, text: string): void => {
  fireEvent.change(input, { target: { value: '' } })
  for (let end = 1; end <= text.length; end++) {
    fireEvent.change(input, { target: { value: text.slice(0, end) } })
  }
}

const wait = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('DicomSettingsPicker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('reports a recognized equipment zone a wait after the last keystroke, and no half-typed one', () => {
    const changes: DicomSettings[] = []
    render(<Harness initial={{ timeZone: 'UTC' }} onChange={(s) => changes.push(s)} />)
    const input = screen.getByLabelText<HTMLInputElement>(ZONE_FIELD)

    typeZone(input, 'America/Vancouver')
    wait(TIME_ZONE_COMMIT_DELAY_MS - 1)
    expect(changes).toEqual([])
    wait(1)

    // Each report re-decodes the whole batch, so the prefixes ('A', 'Am',
    // 'Ame', …) never reach the shell.
    expect(changes).toEqual([{ timeZone: 'America/Vancouver' }])
  })

  it('offers every suggestion as a datalist option', () => {
    render(<Harness initial={{ timeZone: 'UTC' }} onChange={() => {}} />)
    const input = screen.getByLabelText<HTMLInputElement>(ZONE_FIELD)
    const list = document.getElementById(input.getAttribute('list') ?? '')

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
