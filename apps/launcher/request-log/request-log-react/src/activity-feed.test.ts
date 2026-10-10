import { DateTime, Duration, Option } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import {
  activityCountsOf,
  activityEntryOf,
  REFUSED_STREAK_THRESHOLD,
  REFUSED_STREAK_WINDOW,
  refusedStreaksOf,
} from './activity-feed.ts'
import type { CallerSummary, LoggedRequest } from './queries/index.ts'

const NOW = DateTime.unsafeMake('2026-07-01T12:00:00Z')
const NAMES: ReadonlyMap<string, string> = new Map([['lifting', 'Lifting app']])

const caller = (overrides: Partial<CallerSummary>): CallerSummary => ({
  clientId: Option.some('lifting'),
  address: Option.some('198.51.100.24'),
  firstSeen: DateTime.unsafeMake('2026-07-01T10:00:00Z'),
  lastSeen: DateTime.unsafeMake('2026-07-01T11:00:00Z'),
  requestCount: 1,
  refusedCount: 0,
  lastStatus: 200,
  lastRefusal: Option.none(),
  ...overrides,
})

const refusedRequest = (
  id: number,
  address: Option.Option<string>,
  minutesAgo: number,
  overrides: Partial<LoggedRequest> = {}
): LoggedRequest => ({
  id,
  receivedAt: DateTime.subtract(NOW, { minutes: minutesAgo }),
  clientId: Option.none(),
  address,
  servedHost: Option.some('dev1.example.com'),
  method: 'GET',
  path: '/fhir-r4/Patient',
  status: 401,
  responseBytes: Option.none(),
  durationMs: 3,
  refusal: Option.some('tokenRejected'),
  ...overrides,
})

describe('activityEntryOf', () => {
  test("maps a caller's last request onto a feed row", () => {
    expect(activityEntryOf(caller({}), NAMES)).toEqual({
      name: 'Lifting app',
      location: '198.51.100.24',
      lastConnectionAt: DateTime.unsafeMake('2026-07-01T11:00:00Z'),
      access: { auth: 'authorized', clientId: 'lifting' },
    })
  })

  test('falls back to the client id, then Open or No client, for the name', () => {
    expect(activityEntryOf(caller({ clientId: Option.some('other') }), NAMES).name).toBe('other')
    expect(activityEntryOf(caller({ clientId: Option.none() }), NAMES)).toMatchObject({
      name: 'Open',
      access: { auth: 'public' },
    })
    expect(
      activityEntryOf(caller({ clientId: Option.none(), lastStatus: 401 }), NAMES)
    ).toMatchObject({ name: 'No client', access: { auth: 'refused' } })
  })

  test('a caller whose last request was refused is a refused row with the reason', () => {
    expect(
      activityEntryOf(
        caller({ clientId: Option.none(), lastStatus: 401, lastRefusal: Option.some('revoked') }),
        NAMES
      ).access
    ).toEqual({ auth: 'refused', clientId: Option.none(), reason: 'token revoked' })
    expect(activityEntryOf(caller({ lastStatus: 403 }), NAMES).access).toEqual({
      auth: 'refused',
      clientId: Option.some('lifting'),
      reason: 'forbidden',
    })
  })

  test('says so when the address was not recorded', () => {
    expect(activityEntryOf(caller({ address: Option.none() }), NAMES).location).toBe(
      'Unknown address'
    )
  })
})

describe('activityCountsOf', () => {
  test('splits each caller’s admitted requests by whether a client was verified', () => {
    expect(
      activityCountsOf([
        caller({ requestCount: 10, refusedCount: 2 }),
        caller({ clientId: Option.none(), requestCount: 7, refusedCount: 4 }),
        caller({ clientId: Option.some('other'), requestCount: 1 }),
      ])
    ).toEqual({ authorized: 9, public: 3, refused: 6 })
  })

  test('is all zeroes for an empty log', () => {
    expect(activityCountsOf([])).toEqual({ authorized: 0, public: 0, refused: 0 })
  })
})

describe('refusedStreaksOf', () => {
  const burst = (address: string, count: number, minutesAgo = 1): LoggedRequest[] =>
    Array.from({ length: count }, (_, index) =>
      refusedRequest(index, Option.some(address), minutesAgo)
    )

  test(`warns at ${REFUSED_STREAK_THRESHOLD} refused requests from one address`, () => {
    expect(refusedStreaksOf(burst('203.0.113.9', REFUSED_STREAK_THRESHOLD), NOW)).toEqual([
      { address: '203.0.113.9', count: REFUSED_STREAK_THRESHOLD },
    ])
    expect(refusedStreaksOf(burst('203.0.113.9', REFUSED_STREAK_THRESHOLD - 1), NOW)).toEqual([])
  })

  test('counts only refusals inside the window', () => {
    const windowMinutes = Duration.toMinutes(REFUSED_STREAK_WINDOW)
    const requests = [
      ...burst('203.0.113.9', REFUSED_STREAK_THRESHOLD - 1, 1),
      refusedRequest(99, Option.some('203.0.113.9'), windowMinutes + 1),
    ]

    expect(refusedStreaksOf(requests, NOW)).toEqual([])
    expect(
      refusedStreaksOf(
        [...requests, refusedRequest(98, Option.some('203.0.113.9'), windowMinutes)],
        NOW
      )
    ).toEqual([{ address: '203.0.113.9', count: REFUSED_STREAK_THRESHOLD }])
  })

  test('counts each address on its own, most refused first', () => {
    const requests = [
      ...burst('192.0.2.1', REFUSED_STREAK_THRESHOLD),
      ...burst('203.0.113.9', REFUSED_STREAK_THRESHOLD + 5),
      ...burst('198.51.100.24', 3),
    ]

    expect(refusedStreaksOf(requests, NOW).map((streak) => streak.address)).toEqual([
      '203.0.113.9',
      '192.0.2.1',
    ])
  })

  test('ignores requests that were not refused or carry no address', () => {
    const requests = [
      ...burst('203.0.113.9', REFUSED_STREAK_THRESHOLD - 1),
      refusedRequest(50, Option.some('203.0.113.9'), 1, {
        status: 200,
        refusal: Option.none(),
        clientId: Option.some('lifting'),
      }),
      ...Array.from({ length: REFUSED_STREAK_THRESHOLD }, (_, index) =>
        refusedRequest(60 + index, Option.none(), 1)
      ),
    ]

    expect(refusedStreaksOf(requests, NOW)).toEqual([])
  })
})
