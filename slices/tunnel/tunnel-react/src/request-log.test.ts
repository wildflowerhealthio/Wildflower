import { DateTime, Option } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import type { CallerSummary } from './queries.ts'
import {
  accessLabelOf,
  callerNameOf,
  clientActivityOf,
  requestAccessOf,
  type RequestOutcome,
} from './request-log.ts'

const NAMES: ReadonlyMap<string, string> = new Map([['lifting', 'Lifting app']])

const caller = (overrides: Partial<CallerSummary>): CallerSummary => ({
  clientId: 'lifting',
  address: '198.51.100.24',
  firstSeen: DateTime.unsafeMake('2026-07-01T10:00:00Z'),
  lastSeen: DateTime.unsafeMake('2026-07-01T11:00:00Z'),
  requestCount: 1,
  refusedCount: 0,
  lastStatus: 200,
  lastRefusal: null,
  ...overrides,
})

describe('callerNameOf', () => {
  test('prefers the display name, then the client id, then Unauthenticated', () => {
    expect(callerNameOf('lifting', NAMES)).toBe('Lifting app')
    expect(callerNameOf('unnamed-client', NAMES)).toBe('unnamed-client')
    expect(callerNameOf(null, NAMES)).toBe('Unauthenticated')
  })
})

describe('requestAccessOf', () => {
  const outcome = (
    clientId: string | null,
    status: number,
    refusal: RequestOutcome['refusal'] = null
  ): RequestOutcome => ({ clientId, status, refusal })

  test('a verified caller that was not refused is authorized', () => {
    expect(requestAccessOf(outcome('lifting', 200))).toEqual({
      auth: 'authorized',
      clientId: 'lifting',
    })
    expect(requestAccessOf(outcome('lifting', 500))).toMatchObject({ auth: 'authorized' })
  })

  test('a request with no verified caller that was not refused is public', () => {
    expect(requestAccessOf(outcome(null, 200))).toEqual({ auth: 'public' })
    expect(requestAccessOf(outcome(null, 404))).toEqual({ auth: 'public' })
  })

  test("a 401 is refused with the bearer gate's reason", () => {
    expect(requestAccessOf(outcome(null, 401, 'missingToken'))).toEqual({
      auth: 'refused',
      clientId: null,
      reason: 'no token',
    })
    expect(requestAccessOf(outcome(null, 401, 'tokenRejected'))).toMatchObject({
      reason: 'token rejected',
    })
    expect(requestAccessOf(outcome(null, 401, 'revoked'))).toMatchObject({
      reason: 'token revoked',
    })
    expect(requestAccessOf(outcome(null, 401))).toMatchObject({ reason: 'not authorized' })
  })

  test('a 403 is refused, keeping the caller whose scope fell short', () => {
    expect(requestAccessOf(outcome('lifting', 403))).toEqual({
      auth: 'refused',
      clientId: 'lifting',
      reason: 'forbidden',
    })
  })

  test('labels each case for the owner', () => {
    expect(accessLabelOf(requestAccessOf(outcome('lifting', 200)))).toBe('Signed in')
    expect(accessLabelOf(requestAccessOf(outcome(null, 200)))).toBe('No sign-in needed')
    expect(accessLabelOf(requestAccessOf(outcome(null, 401, 'revoked')))).toBe(
      'Refused · token revoked'
    )
  })
})

describe('clientActivityOf', () => {
  test("folds a client's rows across addresses and ignores other callers", () => {
    const activity = clientActivityOf(
      [
        caller({ requestCount: 4, refusedCount: 1 }),
        caller({
          address: '192.0.2.1',
          firstSeen: DateTime.unsafeMake('2026-07-01T09:00:00Z'),
          lastSeen: DateTime.unsafeMake('2026-07-01T12:00:00Z'),
          requestCount: 2,
          refusedCount: 2,
        }),
        caller({ clientId: null, requestCount: 50, refusedCount: 50 }),
      ],
      'lifting'
    )

    expect(activity).toEqual(
      Option.some({
        requestCount: 6,
        refusedCount: 3,
        addressCount: 2,
        firstSeen: DateTime.unsafeMake('2026-07-01T09:00:00Z'),
        lastSeen: DateTime.unsafeMake('2026-07-01T12:00:00Z'),
      })
    )
  })

  test('is none for a client the log holds nothing from', () => {
    expect(clientActivityOf([caller({})], 'other')).toEqual(Option.none())
  })
})
