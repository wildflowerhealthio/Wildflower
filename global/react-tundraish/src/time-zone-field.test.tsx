import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type JSX, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { TIME_ZONE_COMMIT_DELAY_MS, TimeZoneField, UNKNOWN_TIME_ZONE_MESSAGE } from './index.ts'

const LABEL = 'Time zone'
const SUGGESTIONS = ['America/Toronto', 'America/Vancouver']

/** The zone the harness's "set elsewhere" button sets, as another form editing the same setting would. */
const ELSEWHERE_ZONE = 'America/Regina'

/**
 * The field under a parent that owns the reported zone, the way a settings
 * form does — so a report round-trips back in as `value` — with a button that
 * sets the zone from outside the field.
 */
const Harness = ({
  initial,
  onChange,
}: {
  readonly initial: string
  readonly onChange: (timeZone: string) => void
}): JSX.Element => {
  const [timeZone, setTimeZone] = useState(initial)
  return (
    <>
      <button type="button" onClick={() => setTimeZone(ELSEWHERE_ZONE)}>
        set elsewhere
      </button>
      <TimeZoneField
        label={LABEL}
        value={timeZone}
        suggestions={SUGGESTIONS}
        onChange={(next) => {
          setTimeZone(next)
          onChange(next)
        }}
      />
    </>
  )
}

const setElsewhere = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'set elsewhere' }))
}

const zoneInput = (): HTMLInputElement => screen.getByLabelText<HTMLInputElement>(LABEL)

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

describe('TimeZoneField', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('reports a typed zone once, a wait after the last keystroke', () => {
    const onChange = vi.fn()
    render(<Harness initial="UTC" onChange={onChange} />)
    const input = zoneInput()

    typeZone(input, 'America/Vancouver')
    expect(input.value).toBe('America/Vancouver')
    wait(TIME_ZONE_COMMIT_DELAY_MS - 1)
    expect(onChange).not.toHaveBeenCalled()
    wait(1)

    expect(onChange.mock.calls).toEqual([['America/Vancouver']])
  })

  it('reports nothing while the name typed is not a zone, and flags it', () => {
    const onChange = vi.fn()
    render(<Harness initial="UTC" onChange={onChange} />)
    const input = zoneInput()

    typeZone(input, 'America/Tor')
    wait(TIME_ZONE_COMMIT_DELAY_MS * 2)
    fireEvent.blur(input)

    expect(onChange).not.toHaveBeenCalled()
    expect(input.value).toBe('America/Tor')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain(UNKNOWN_TIME_ZONE_MESSAGE)
    expect(input.getAttribute('aria-describedby')).toBe(alert.id)
  })

  it('drops a recognized zone typed past before the wait is out', () => {
    // `UTC` is a zone, `UTCx` is not: the `UTC` scheduled on the way must not
    // be reported a beat later.
    const onChange = vi.fn()
    render(<Harness initial="America/Toronto" onChange={onChange} />)

    typeZone(zoneInput(), 'UTCx')
    wait(TIME_ZONE_COMMIT_DELAY_MS * 2)

    expect(onChange).not.toHaveBeenCalled()
  })

  it('reports the pending zone at once when the field is left', () => {
    const onChange = vi.fn()
    render(<Harness initial="UTC" onChange={onChange} />)
    const input = zoneInput()

    typeZone(input, 'America/Halifax')
    fireEvent.blur(input)

    expect(onChange.mock.calls).toEqual([['America/Halifax']])
    wait(TIME_ZONE_COMMIT_DELAY_MS)
    expect(onChange.mock.calls).toEqual([['America/Halifax']])
  })

  it('reports the pending zone at once on Enter', () => {
    const onChange = vi.fn()
    render(<Harness initial="UTC" onChange={onChange} />)
    const input = zoneInput()

    typeZone(input, 'America/Regina')
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onChange.mock.calls).toEqual([['America/Regina']])
  })

  it('keeps what is typed against a report echoing back', () => {
    render(<Harness initial="UTC" onChange={() => {}} />)
    const input = zoneInput()

    typeZone(input, 'America/Denver')
    wait(TIME_ZONE_COMMIT_DELAY_MS)
    fireEvent.change(input, { target: { value: 'America/DenverX' } })

    expect(input.value).toBe('America/DenverX')
  })

  it('shows a zone set from outside, and drops the report pending under it', () => {
    const onChange = vi.fn()
    render(<Harness initial="UTC" onChange={onChange} />)
    const input = zoneInput()

    typeZone(input, 'America/Halifax')
    setElsewhere()
    expect(input.value).toBe(ELSEWHERE_ZONE)
    wait(TIME_ZONE_COMMIT_DELAY_MS * 2)
    fireEvent.blur(input)

    expect(onChange).not.toHaveBeenCalled()
    expect(input.value).toBe(ELSEWHERE_ZONE)
  })

  it('does not report a zone equal to the one it was given', () => {
    // Deleting a letter and typing it back changes nothing the caller holds.
    const onChange = vi.fn()
    render(<Harness initial="America/Toronto" onChange={onChange} />)
    const input = zoneInput()

    fireEvent.change(input, { target: { value: 'America/Toront' } })
    fireEvent.change(input, { target: { value: 'America/Toronto' } })
    wait(TIME_ZONE_COMMIT_DELAY_MS * 2)
    fireEvent.blur(input)

    expect(onChange).not.toHaveBeenCalled()
  })

  it('reports nothing more on a blur after the wait has reported', () => {
    const onChange = vi.fn()
    render(<Harness initial="UTC" onChange={onChange} />)
    const input = zoneInput()

    typeZone(input, 'America/Denver')
    wait(TIME_ZONE_COMMIT_DELAY_MS)
    fireEvent.blur(input)

    expect(onChange.mock.calls).toEqual([['America/Denver']])
  })

  it('reports nothing once unmounted with a report pending', () => {
    const onChange = vi.fn()
    const { unmount } = render(<Harness initial="UTC" onChange={onChange} />)

    typeZone(zoneInput(), 'America/Denver')
    unmount()
    wait(TIME_ZONE_COMMIT_DELAY_MS * 2)

    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps the field focused and the caret placed while typing', async () => {
    // Real timers: user-event's clear and type never settle under this
    // suite's fake setTimeout, and the caret is placed by the keystrokes, not
    // by the wait.
    vi.useRealTimers()
    render(<Harness initial="UTC" onChange={() => {}} />)
    const input = zoneInput()

    await userEvent.clear(input)
    await userEvent.type(input, 'America/Denver')

    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe('America/Denver'.length)
    expect(input.value).toBe('America/Denver')
  })

  it('clears the flag once the name is a zone', () => {
    render(<Harness initial="Mars/Olympus" onChange={() => {}} />)
    const input = zoneInput()
    expect(input.getAttribute('aria-invalid')).toBe('true')

    typeZone(input, 'America/Vancouver')

    expect(input.getAttribute('aria-invalid')).toBe('false')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('offers every suggestion as a datalist option', () => {
    render(<Harness initial="UTC" onChange={() => {}} />)
    const list = document.getElementById(zoneInput().getAttribute('list') ?? '')

    const offered = [...(list?.querySelectorAll('option') ?? [])].map((option) => option.value)
    expect(offered).toEqual(SUGGESTIONS)
  })

  it('passes root props through to its field', () => {
    render(
      <TimeZoneField
        id="zone-field"
        className="extra"
        data-anchor="zone"
        label={LABEL}
        value="UTC"
        suggestions={SUGGESTIONS}
        onChange={() => {}}
      />
    )

    const root = document.getElementById('zone-field')
    expect(root?.dataset['anchor']).toBe('zone')
    expect(root?.classList.contains('extra')).toBe(true)
    expect(root?.contains(zoneInput())).toBe(true)
  })
})
