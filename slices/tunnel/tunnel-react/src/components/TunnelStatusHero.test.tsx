import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { Tunnel } from 'tunnel-core/http-api-definition'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import type { TunnelState } from '../queries.ts'
import { TunnelStatusHero } from './TunnelStatusHero.tsx'

const ONLINE_WITH_HOST: TunnelState = {
  ...Tunnel.freshTunnelState,
  requestedRunning: true,
  running: true,
  publicHost: 'ruth.wildflowerhealth.io',
}

const OFF: TunnelState = {
  ...Tunnel.freshTunnelState,
  requestedRunning: false,
  running: false,
  publicHost: null,
}

afterEach(() => {
  cleanup()
})

describe('TunnelStatusHero — status badge', () => {
  test.each([
    [true, true, 'Online'],
    [true, false, 'Starting…'],
    [false, true, 'Stopping…'],
    [false, false, 'Off'],
  ] as const)(
    '(requestedRunning=%s, running=%s, error=null) → "%s" badge',
    (requestedRunning, running, label) => {
      const state: TunnelState = { ...Tunnel.freshTunnelState, requestedRunning, running }
      render(<TunnelStatusHero state={state} onToggle={() => {}} />)
      expect(screen.getByRole('status').textContent).toContain(label)
    }
  )

  // Any non-null error wins regardless of run state — the badge becomes
  // "Error" so the user is not told the tunnel is "Online" while the
  // daemon is reporting a failure.
  test('any non-null error renders the "Error" badge', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.string({ minLength: 1, maxLength: 32 }).filter((s) => s.trim().length > 0),
        (requestedRunning, running, error) => {
          cleanup()
          const state: TunnelState = {
            ...Tunnel.freshTunnelState,
            requestedRunning,
            running,
            error,
          }
          render(<TunnelStatusHero state={state} onToggle={() => {}} />)
          expect(screen.getByRole('status').textContent).toContain('Error')
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('Online badge pulses (opt-in liveliness cue)', () => {
    render(<TunnelStatusHero state={ONLINE_WITH_HOST} onToggle={() => {}} />)
    expect(screen.getByRole('status').classList.contains('pulse')).toBe(true)
  })

  test('Off badge does not pulse', () => {
    render(<TunnelStatusHero state={OFF} onToggle={() => {}} />)
    expect(screen.getByRole('status').classList.contains('pulse')).toBe(false)
  })
})

describe('TunnelStatusHero — switch', () => {
  test('the switch reflects requestedRunning', () => {
    render(<TunnelStatusHero state={ONLINE_WITH_HOST} onToggle={() => {}} />)
    const sw = screen.getByRole<HTMLInputElement>('switch', { name: 'Run tunnel' })
    expect(sw.checked).toBe(true)
  })

  test('toggling the switch calls onToggle with the new value', () => {
    let captured: boolean | null = null
    render(
      <TunnelStatusHero
        state={OFF}
        onToggle={(next) => {
          captured = next
        }}
      />
    )
    fireEvent.click(screen.getByRole('switch', { name: 'Run tunnel' }))
    expect(captured).toBe(true)
  })

  test('disabled disables the switch and tolerates an omitted onToggle', () => {
    render(<TunnelStatusHero state={ONLINE_WITH_HOST} disabled />)
    const sw = screen.getByRole<HTMLInputElement>('switch', { name: 'Run tunnel' })
    expect(sw.disabled).toBe(true)
  })

  // A disabled hero (e.g. while a pending mutation locks the control) must not
  // fire the callback even when one is supplied — the live toggle is the tunnel
  // control, so a stray call mid-flight would issue a second write.
  test('disabled hero never calls onToggle even when one is supplied', () => {
    let called = false
    render(
      <TunnelStatusHero
        state={ONLINE_WITH_HOST}
        disabled
        onToggle={() => {
          called = true
        }}
      />
    )
    const sw = screen.getByRole<HTMLInputElement>('switch', { name: 'Run tunnel' })
    expect(sw.disabled).toBe(true)
    fireEvent.click(sw)
    expect(called).toBe(false)
  })
})

describe('TunnelStatusHero — address block', () => {
  test('shows the public host when set', () => {
    render(<TunnelStatusHero state={ONLINE_WITH_HOST} onToggle={() => {}} />)
    expect(screen.getByText('ruth.wildflowerhealth.io')).toBeTruthy()
  })

  test('shows a clear "no host" sentinel and disables copy when publicHost is null', () => {
    render(<TunnelStatusHero state={OFF} onToggle={() => {}} />)
    expect(screen.getByText('No public host set')).toBeTruthy()
    const copy = screen.getByRole('button', { name: 'Copy public host' })
    if (!(copy instanceof HTMLButtonElement)) throw new Error('expected <button>')
    expect(copy.disabled).toBe(true)
  })

  test('renders the stubbed "0 apps connected now" sub-line', () => {
    render(<TunnelStatusHero state={ONLINE_WITH_HOST} onToggle={() => {}} />)
    expect(screen.getByText('0 apps connected now')).toBeTruthy()
  })
})

describe('TunnelStatusHero — error', () => {
  test('renders an alert region when state.error is non-null', () => {
    const state: TunnelState = { ...OFF, error: 'dial failed' }
    render(<TunnelStatusHero state={state} onToggle={() => {}} />)
    expect(screen.getByRole('alert').textContent).toBe('dial failed')
  })

  test('renders no alert region when state.error is null', () => {
    render(<TunnelStatusHero state={OFF} onToggle={() => {}} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
