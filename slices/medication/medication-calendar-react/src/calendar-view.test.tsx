import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import type { MedicationView } from 'medication-sponsorship-react'

import { CalendarView } from './calendar-view.tsx'

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date('2026-09-03T12:00:00'))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

// The grid and the schedule are both in the DOM (CSS swaps them at 640px),
// so queries scope to one surface.
const grid = (): HTMLElement => screen.getByRole('table')
const agenda = (): HTMLElement => {
  const pane = document.querySelector('[aria-label="Schedule"]')
  if (!(pane instanceof HTMLElement)) throw new Error('schedule pane not rendered')
  return pane
}

describe('CalendarView', () => {
  it('opens on the current month with Sunday-first weekday headers', () => {
    render(<CalendarView medications={[]} />)

    expect(screen.getByRole('heading', { name: 'September 2026' })).toBeDefined()
    const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent)
    expect(headers).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])
  })

  it('shows a pickup item on the next-fill date of a prescription with repeats left', () => {
    render(<CalendarView medications={[amoxicillinWithRefills]} />)

    const cell = within(grid()).getByText('Pickup next refill of Amoxicillin').closest('td')
    expect(cell?.textContent).toContain('9')
  })

  it('shows the renewal appointment a week ahead and the marker on the exhaustion day', () => {
    render(<CalendarView medications={[ramiprilOutOfRepeats]} />)

    expect(within(grid()).getByText('Book appointment with Dr. Priya Rao')).toBeDefined()
    expect(within(grid()).getByText('Supply exhausted: Ramipril')).toBeDefined()
  })

  it('falls back to "your prescriber" when the prescription names no requester', () => {
    render(<CalendarView medications={[{ ...ramiprilOutOfRepeats, requester: null }]} />)

    expect(within(grid()).getByText('Book appointment with your prescriber')).toBeDefined()
  })

  it('merges same-day items of one kind into a single fluent entry', () => {
    render(
      <CalendarView
        medications={[
          amoxicillinWithRefills,
          {
            ...amoxicillinWithRefills,
            medication: {
              ...amoxicillinWithRefills.medication,
              id: 'rx-3',
              displayName: 'Naproxen',
            },
          },
        ]}
      />
    )

    expect(within(grid()).getByText('Pickup next refill of Amoxicillin and Naproxen')).toBeDefined()
    expect(within(grid()).queryByText('Pickup next refill of Amoxicillin')).toBeNull()
  })

  it('stacks every event by day in the schedule, split by a red Now line', () => {
    render(<CalendarView medications={[amoxicillinWithRefills, ramiprilOutOfRepeats]} />)

    const pane = agenda()
    const nowLine = within(pane).getByRole('separator', { name: 'Now' })
    expect(nowLine).toBeDefined()
    // All three events are after "now" (Sep 3): pickup Sep 9, appointment
    // Sep 16, exhaustion Sep 23 — each under its own day heading.
    const days = within(pane)
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent)
    expect(days).toEqual(['Wed, Sep 9', 'Wed, Sep 16', 'Wed, Sep 23'])
    expect(within(pane).getByText('Pickup next refill of Amoxicillin')).toBeDefined()
    // Nothing precedes the Now line — no past events.
    expect(nowLine.previousElementSibling).toBeNull()
  })

  it('puts events dated before today above the Now line in the schedule', () => {
    render(
      <CalendarView
        medications={[
          {
            ...amoxicillinWithRefills,
            nextFillDate: '2026-08-16T00:00:00Z',
          },
        ]}
      />
    )

    const pane = agenda()
    const nowLine = within(pane).getByRole('separator', { name: 'Now' })
    expect(nowLine.previousElementSibling?.textContent).toContain(
      'Pickup next refill of Amoxicillin'
    )
    expect(within(pane).getByRole('heading', { level: 3 }).textContent).toBe('Sun, Aug 16')
  })

  it('navigates between months', async () => {
    const user = userEvent.setup()
    render(<CalendarView medications={[]} />)

    await user.click(screen.getByRole('button', { name: 'Next month' }))
    expect(screen.getByRole('heading', { name: 'October 2026' })).toBeDefined()

    await user.click(screen.getByRole('button', { name: 'Previous month' }))
    await user.click(screen.getByRole('button', { name: 'Previous month' }))
    expect(screen.getByRole('heading', { name: 'August 2026' })).toBeDefined()
  })

  it('marks today in the grid', () => {
    render(<CalendarView medications={[]} />)

    const today = document.querySelector('[aria-current="date"]')
    expect(today?.textContent).toBe('3')
  })
})

// Helpers

const baseView: Omit<MedicationView, 'medication'> = {
  din: null,
  description: null,
  requester: null,
  note: null,
  repeatsAllowed: null,
  repeatsAvailable: null,
  nextFillDate: null,
  rexallStoreUrl: null,
  shoppersStoreUrl: null,
}

/** Repeats remain → its next-fill date (Sep 9) carries the pickup item. */
const amoxicillinWithRefills: MedicationView = {
  ...baseView,
  medication: {
    id: 'rx-1',
    displayName: 'Amoxicillin',
    status: 'active',
    authoredOn: '2026-08-10T00:00:00Z',
  },
  repeatsAllowed: 3,
  repeatsAvailable: 2,
  nextFillDate: '2026-09-09T00:00:00Z',
}

/** No repeats left → appointment on Sep 16, exhaustion marker on Sep 23. */
const ramiprilOutOfRepeats: MedicationView = {
  ...baseView,
  medication: {
    id: 'rx-2',
    displayName: 'Ramipril',
    status: 'active',
    authoredOn: '2026-06-23T00:00:00Z',
  },
  requester: 'Priya Rao',
  repeatsAllowed: 2,
  repeatsAvailable: 0,
  nextFillDate: '2026-09-23T00:00:00Z',
}
