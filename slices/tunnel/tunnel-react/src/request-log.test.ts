import { DateTime, Option } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import type { CallerSummary } from './queries/index.ts'
import {
  accessLabelOf,
  callerNameOf,
  clientActivityOf,
  requestAccessOf,
  type RequestOutcome,
} from './request-log.ts'

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

describe('callerNameOf', () => {
  test('prefers the display name, then the client id, then Unauthenticated', () => {
    expect(callerNameOf(Option.some('lifting'), NAMES)).toBe('Lifting app')
    expect(callerNameOf(Option.some('unnamed-client'), NAMES)).toBe('unnamed-client')
    expect(callerNameOf(Option.none(), NAMES)).toBe('Unauthenticated')
  })
})

describe('requestAccessOf', () => {
  const LIFTING = Option.some('lifting')
  const NO_CALLER = Option.none<string>()
  const outcome = (
    clientId: Option.Option<string>,
    status: number,
    refusal: RequestOutcome['refusal'] = Option.none()
  ): RequestOutcome => ({ clientId, status, refusal })

  test('a verified caller that was not refused is authorized', () => {
    expect(requestAccessOf(outcome(LIFTING, 200))).toEqual({
      auth: 'authorized',
      clientId: 'lifting',
    })
    expect(requestAccessOf(outcome(LIFTING, 500))).toMatchObject({ auth: 'authorized' })
  })

  test('a request with no verified caller that was not refused is public', () => {
    expect(requestAccessOf(outcome(NO_CALLER, 200))).toEqual({ auth: 'public' })
    expect(requestAccessOf(outcome(NO_CALLER, 404))).toEqual({ auth: 'public' })
  })

  test("a 401 is refused with the bearer gate's reason", () => {
    expect(requestAccessOf(outcome(NO_CALLER, 401, Option.some('missingToken')))).toEqual({
      auth: 'refused',
      clientId: Option.none(),
      reason: 'no token',
    })
    expect(requestAccessOf(outcome(NO_CALLER, 401, Option.some('tokenRejected')))).toMatchObject({
      reason: 'token rejected',
    })
    expect(requestAccessOf(outcome(NO_CALLER, 401, Option.some('revoked')))).toMatchObject({
      reason: 'token revoked',
    })
    expect(requestAccessOf(outcome(NO_CALLER, 401))).toMatchObject({ reason: 'not authorized' })
  })

  test('a 403 is refused, keeping the caller whose scope fell short', () => {
    expect(requestAccessOf(outcome(LIFTING, 403))).toEqual({
      auth: 'refused',
      clientId: Option.some('lifting'),
      reason: 'forbidden',
    })
  })

  test('labels each case for the owner', () => {
    expect(accessLabelOf(requestAccessOf(outcome(LIFTING, 200)))).toBe('Signed in')
    expect(accessLabelOf(requestAccessOf(outcome(NO_CALLER, 200)))).toBe('No sign-in needed')
    expect(accessLabelOf(requestAccessOf(outcome(NO_CALLER, 401, Option.some('revoked'))))).toBe(
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
          address: Option.some('192.0.2.1'),
          firstSeen: DateTime.unsafeMake('2026-07-01T09:00:00Z'),
          lastSeen: DateTime.unsafeMake('2026-07-01T12:00:00Z'),
          requestCount: 2,
          refusedCount: 2,
        }),
        caller({ clientId: Option.none(), requestCount: 50, refusedCount: 50 }),
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
