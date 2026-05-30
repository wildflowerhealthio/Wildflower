import { cleanup, fireEvent, render } from '@testing-library/react'
import fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { type JSX } from 'react'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import { TunnelToggle } from '../src/components/TunnelToggle.tsx'

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

describe('<TunnelToggle> status badge', () => {
  // Each `render()` mounts to the shared jsdom `body`; without cleanup
  // the previous test's DOM lingers and `getByRole('status')` finds
  // multiple matches.
  afterEach(() => {
    cleanup()
  })

  // Decision table that the toggle renders for `(requestedRunning, running, error)`,
  // mirrored from the comment on `deriveTunnelStatus` inside `TunnelToggle.tsx`.
  test.each([
    [true, true, 'Online'],
    [true, false, 'Starting…'],
    [false, true, 'Stopping…'],
    [false, false, 'Stopped'],
  ] as const)(
    '(requestedRunning=%s, running=%s, error=null) renders the "%s" badge',
    (requestedRunning, running, label) => {
      const { getByRole } = render(buildElement({ requestedRunning, running, error: null }))
      const badge = getByRole('status')
      expect(badge.textContent).toContain(label)
    }
  )

  test('any non-null error renders the "Error" badge regardless of running/requestedRunning', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.string({ minLength: 1, maxLength: 64 }).filter((s) => s.trim().length > 0),
        (requestedRunning, running, error) => {
          // fc.assert re-runs inside the same `test`; clear the DOM each pass.
          cleanup()
          const { getByRole } = render(buildElement({ requestedRunning, running, error }))
          const badge = getByRole('status')
          expect(badge.textContent).toContain('Error')
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('<TunnelToggle> behavior', () => {
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
