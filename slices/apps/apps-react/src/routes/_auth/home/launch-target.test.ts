import { describe, expect, test } from 'vite-plus/test'

import type { TunnelState } from 'tunnel-react'

import type { AppEntry } from '../../../queries.ts'
import { launchTarget } from './launch-target.ts'

const app = (requiresTunnel: boolean): AppEntry => ({
  id: 'growth-chart',
  name: 'Growth Chart',
  url: 'https://ehr.example/launch?iss={origin}&launch={launch}',
  requiresTunnel,
  enabled: true,
})

/**
 * A `TunnelState` in the given `status`. `running` is derived the way the
 * server does (`dialing`/`verified`/`unreachable`) so the fixtures stay
 * faithful — and so the test pins that `running` is *not* what the gate keys
 * on: `dialing`/`unreachable` are `running: true` yet must route to the bridge.
 */
const tunnelState = (
  status: TunnelState['status'],
  servedOrigin = 'http://127.0.0.1:8080'
): TunnelState => ({
  settingsRevision: 3,
  publicHost: 'dev1.example.com',
  requestedRunning: status !== 'off',
  status,
  running: status === 'dialing' || status === 'verified' || status === 'unreachable',
  error: null,
  dialAttempts: 0,
  servedOrigin,
  relay: null,
})

const ALL_STATUSES: readonly TunnelState['status'][] = [
  'off',
  'misconfigured',
  'dialing',
  'verified',
  'unreachable',
]

describe('launchTarget', () => {
  test('a non-tunnel app always goes to the loopback origin, whatever the tunnel is doing', () => {
    for (const status of ALL_STATUSES) {
      expect(launchTarget(app(false), tunnelState(status))).toEqual({ via: 'loopback' })
    }
  })

  test('a tunnel app on a verified tunnel goes straight to the public served origin', () => {
    expect(launchTarget(app(true), tunnelState('verified', 'https://dev1.example.com'))).toEqual({
      via: 'served',
      origin: 'https://dev1.example.com',
    })
  })

  test('a tunnel app routes through the bridge for every non-verified status', () => {
    // Includes `dialing`/`unreachable`, which are `running: true` but whose
    // `servedOrigin` is still loopback — the case the old `running` gate got
    // wrong by redirecting to loopback and bypassing the tunnel.
    for (const status of ALL_STATUSES.filter((s) => s !== 'verified')) {
      expect(launchTarget(app(true), tunnelState(status))).toEqual({ via: 'bridge' })
    }
  })
})
