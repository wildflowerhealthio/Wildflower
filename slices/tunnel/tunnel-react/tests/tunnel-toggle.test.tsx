import { cleanup, fireEvent, render } from '@testing-library/react'
import fc from 'fast-check'
import { type JSX } from 'react'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import { deriveTunnelStatus } from '../src/components/derive-tunnel-status.ts'
import { TunnelToggle } from '../src/components/TunnelToggle.tsx'

describe('deriveTunnelStatus', () => {
  // Exhaustive decision-table sweep — three booleans plus error-or-not.
  // We test the *shape* of the decision (which tone, which label) rather
  // than the exact strings, except where the spec calls for a specific
  // label (`Online` / `Stopped`).

  test('error always surfaces as danger regardless of running/requestedRunning', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.string({ minLength: 1, maxLength: 64 }).filter((s) => s.trim().length > 0),
        (requestedRunning, running, error) => {
          const status = deriveTunnelStatus(requestedRunning, running, error)
          expect(status.tone).toBe('danger')
          expect(status.label).toBe('Error')
        }
      )
    )
  })

  test('(true, true, null) → success Online', () => {
    expect(deriveTunnelStatus(true, true, null)).toEqual({ tone: 'success', label: 'Online' })
  })

  test('(true, false, null) → info Starting…', () => {
    expect(deriveTunnelStatus(true, false, null)).toEqual({ tone: 'info', label: 'Starting…' })
  })

  test('(false, true, null) → warning Stopping…', () => {
    expect(deriveTunnelStatus(false, true, null)).toEqual({
      tone: 'warning',
      label: 'Stopping…',
    })
  })

  test('(false, false, null) → neutral Stopped', () => {
    expect(deriveTunnelStatus(false, false, null)).toEqual({ tone: 'neutral', label: 'Stopped' })
  })

  test('tone is one of the documented StatusTone variants', () => {
    const allowed = new Set(['neutral', 'info', 'success', 'warning', 'danger'])
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.option(fc.string(), { nil: null }),
        (requestedRunning, running, error) => {
          const status = deriveTunnelStatus(requestedRunning, running, error)
          expect(allowed.has(status.tone)).toBe(true)
        }
      )
    )
  })
})

// Build the element via a tagged-union switch so the
// `disabled` / `onToggle` permutation type-checks cleanly. The
// component's prop union forbids omitting `onToggle` unless
// `disabled: true`, and TypeScript can't otherwise narrow inside an
// object spread.
const buildElement = (overrides: {
  readonly requestedRunning?: boolean
  readonly running?: boolean
  readonly error?: string | null
  readonly disabled?: boolean
  readonly onToggle?: (next: boolean) => void
}): JSX.Element => {
  const requestedRunning = overrides.requestedRunning ?? false
  const running = overrides.running ?? false
  const error = overrides.error ?? null
  const onToggle = overrides.onToggle ?? ((): void => {})
  if (overrides.disabled === true) {
    return (
      <TunnelToggle
        requestedRunning={requestedRunning}
        running={running}
        error={error}
        disabled
        onToggle={onToggle}
      />
    )
  }
  return (
    <TunnelToggle
      requestedRunning={requestedRunning}
      running={running}
      error={error}
      onToggle={onToggle}
    />
  )
}

describe('<TunnelToggle>', () => {
  // Each `render()` mounts to the shared jsdom `body`; without cleanup
  // the previous test's DOM lingers and `getByRole('checkbox')` finds
  // multiple matches.
  afterEach(() => {
    cleanup()
  })

  test('renders the requestedRunning state on the checkbox', () => {
    const { getByRole } = render(buildElement({ requestedRunning: true }))
    const checkbox = getByRole('checkbox')
    if (!(checkbox instanceof HTMLInputElement)) {
      throw new Error('expected checkbox to be an HTMLInputElement')
    }
    expect(checkbox.checked).toBe(true)
  })

  test('toggling the checkbox calls onToggle with the new value', () => {
    let captured: boolean | null = null
    const { getByRole } = render(
      buildElement({
        requestedRunning: false,
        onToggle: (next) => {
          captured = next
        },
      })
    )
    const checkbox = getByRole('checkbox')
    fireEvent.click(checkbox)
    expect(captured).toBe(true)
  })

  test('disabled prop disables the checkbox', () => {
    const { getByRole } = render(buildElement({ disabled: true }))
    const checkbox = getByRole('checkbox')
    if (!(checkbox instanceof HTMLInputElement)) {
      throw new Error('expected checkbox to be an HTMLInputElement')
    }
    expect(checkbox.disabled).toBe(true)
  })

  test('error renders in an alert region', () => {
    const { getByRole } = render(buildElement({ error: 'boom' }))
    const alert = getByRole('alert')
    expect(alert.textContent).toBe('boom')
  })

  test('no alert region when error is null', () => {
    const { queryByRole } = render(buildElement({ error: null }))
    expect(queryByRole('alert')).toBeNull()
  })
})
