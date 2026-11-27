import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { LifeLabsPdfSettings } from '@wildflowerhealthio/lifelabs-pdf-importer-core'
import { TIME_ZONE_COMMIT_DELAY_MS } from '@wildflowerhealthio/react-tundraish'
import { type JSX, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { LifeLabsPdfSettingsPicker } from './index.ts'

const ZONE_FIELD = 'Report time zone'
const PROVINCE_FIELD = 'Health card province'

/**
 * The picker under a parent that owns the settings, the way the shell does —
 * so a report round-trips back in as a prop and the test sees what the
 * reviewer would.
 */
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

describe('LifeLabsPdfSettingsPicker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('reports nothing while the zone typed is not one the runtime recognizes', () => {
    const changes: LifeLabsPdfSettings[] = []
    render(
      <Harness
        initial={{ timeZone: 'America/Vancouver', healthCardProvince: 'ON' }}
        onChange={(s) => changes.push(s)}
      />
    )
    const input = screen.getByLabelText<HTMLInputElement>(ZONE_FIELD)

    typeZone(input, 'America/Tor')
    wait(TIME_ZONE_COMMIT_DELAY_MS * 2)
    fireEvent.blur(input)

    expect(changes).toEqual([])
    expect(input.getAttribute('aria-invalid')).toBe('true')
  })

  it('reports a recognized zone once, a wait after the last keystroke', () => {
    const changes: LifeLabsPdfSettings[] = []
    render(
      <Harness
        initial={{ timeZone: 'America/Vancouver', healthCardProvince: 'ON' }}
        onChange={(s) => changes.push(s)}
      />
    )
    const input = screen.getByLabelText<HTMLInputElement>(ZONE_FIELD)

    typeZone(input, 'America/Toronto')
    wait(TIME_ZONE_COMMIT_DELAY_MS - 1)
    expect(changes).toEqual([])
    wait(1)

    expect(changes).toEqual([{ timeZone: 'America/Toronto', healthCardProvince: 'ON' }])
    expect(input.value).toBe('America/Toronto')
  })

  it('reports the pending zone at once when the field is left', () => {
    const changes: LifeLabsPdfSettings[] = []
    render(
      <Harness
        initial={{ timeZone: 'America/Toronto', healthCardProvince: 'ON' }}
        onChange={(s) => changes.push(s)}
      />
    )
    const input = screen.getByLabelText<HTMLInputElement>(ZONE_FIELD)

    typeZone(input, 'UTC')
    fireEvent.blur(input)

    expect(changes).toEqual([{ timeZone: 'UTC', healthCardProvince: 'ON' }])
  })

  it('shows a zone set from outside', () => {
    const Outer = (): JSX.Element => {
      const [settings, setSettings] = useState<LifeLabsPdfSettings>({
        timeZone: 'America/Toronto',
        healthCardProvince: 'ON',
      })
      return (
        <>
          <button
            type="button"
            onClick={() => setSettings({ ...settings, timeZone: 'America/Vancouver' })}
          >
            set elsewhere
          </button>
          <LifeLabsPdfSettingsPicker settings={settings} onChange={setSettings} />
        </>
      )
    }
    render(<Outer />)

    fireEvent.click(screen.getByRole('button', { name: 'set elsewhere' }))

    expect(screen.getByLabelText<HTMLInputElement>(ZONE_FIELD).value).toBe('America/Vancouver')
  })

  it('reports a change of health card province at once', () => {
    const changes: LifeLabsPdfSettings[] = []
    render(
      <Harness
        initial={{ timeZone: 'America/Vancouver', healthCardProvince: 'ON' }}
        onChange={(s) => changes.push(s)}
      />
    )
    const select = screen.getByLabelText<HTMLSelectElement>(PROVINCE_FIELD)

    expect(select.value).toBe('ON')
    expect([...select.options].map((option) => option.text)).toEqual([
      'Ontario',
      'British Columbia',
      'Other province',
    ])
    fireEvent.change(select, { target: { value: 'BC' } })
    fireEvent.change(select, { target: { value: 'Other' } })

    expect(changes).toEqual([
      { timeZone: 'America/Vancouver', healthCardProvince: 'BC' },
      { timeZone: 'America/Vancouver', healthCardProvince: 'Other' },
    ])
    expect(select.value).toBe('Other')
  })

  it('keeps a province picked while a zone is pending when the zone is reported', () => {
    const changes: LifeLabsPdfSettings[] = []
    render(
      <Harness
        initial={{ timeZone: 'America/Vancouver', healthCardProvince: 'ON' }}
        onChange={(s) => changes.push(s)}
      />
    )

    typeZone(screen.getByLabelText<HTMLInputElement>(ZONE_FIELD), 'America/Toronto')
    fireEvent.change(screen.getByLabelText(PROVINCE_FIELD), { target: { value: 'BC' } })
    wait(TIME_ZONE_COMMIT_DELAY_MS)

    expect(changes).toEqual([
      { timeZone: 'America/Vancouver', healthCardProvince: 'BC' },
      { timeZone: 'America/Toronto', healthCardProvince: 'BC' },
    ])
  })
})
