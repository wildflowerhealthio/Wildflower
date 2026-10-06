import { cleanup, render, screen } from '@testing-library/react'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { Tunnel } from 'tunnel-core/http-api-definition'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import type { TunnelState } from '../queries/index.ts'
import { TunnelStatusHero } from './TunnelStatusHero.tsx'

const VERIFIED: TunnelState = { ...Tunnel.freshTunnelState, status: 'verified' }

afterEach(() => {
  cleanup()
})

describe('TunnelStatusHero — status badge', () => {
  test.each([
    ['verified', 'Online'],
    ['dialing', 'Connecting…'],
    ['unreachable', 'Connecting…'],
  ] as const)('(status=%s, error=null) → "%s" badge', (status, label) => {
    render(<TunnelStatusHero state={{ ...Tunnel.freshTunnelState, status }} />)
    expect(screen.getByRole('status').textContent).toContain(label)
  })

  // Any non-null error wins regardless of status — the badge becomes "Error"
  // so the user is not told the tunnel is "Online" while the daemon is
  // reporting a failure.
  test('any non-null error renders the "Error" badge', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...Tunnel.TunnelStateViewSchema.fields.status.literals),
        fc.string({ minLength: 1, maxLength: 32 }).filter((s) => s.trim().length > 0),
        (status, error) => {
          cleanup()
          render(<TunnelStatusHero state={{ ...Tunnel.freshTunnelState, status, error }} />)
          expect(screen.getByRole('status').textContent).toContain('Error')
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('Online badge pulses (opt-in liveliness cue)', () => {
    render(<TunnelStatusHero state={VERIFIED} />)
    expect(screen.getByRole('status').classList.contains('pulse')).toBe(true)
  })

  test('Connecting badge does not pulse', () => {
    render(<TunnelStatusHero state={Tunnel.freshTunnelState} />)
    expect(screen.getByRole('status').classList.contains('pulse')).toBe(false)
  })
})

describe('TunnelStatusHero — read-only', () => {
  test('offers no controls', () => {
    render(<TunnelStatusHero state={VERIFIED} />)
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryAllByRole('button')).toEqual([])
  })
})

describe('TunnelStatusHero — address block', () => {
  test('renders the stubbed "0 apps connected now" sub-line', () => {
    render(<TunnelStatusHero state={VERIFIED} />)
    expect(screen.getByText('0 apps connected now')).toBeTruthy()
  })
})

describe('TunnelStatusHero — error', () => {
  test('renders an alert region when state.error is non-null', () => {
    const state: TunnelState = { ...Tunnel.freshTunnelState, error: 'dial failed' }
    render(<TunnelStatusHero state={state} />)
    expect(screen.getByRole('alert').textContent).toBe('dial failed')
  })

  test('renders no alert region when state.error is null', () => {
    render(<TunnelStatusHero state={VERIFIED} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
