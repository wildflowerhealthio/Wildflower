import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise } from '@livestore/livestore'
import { DateTime, LogLevel } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { AuthorizationRequest, events, schema } from './index.ts'
import type { AuthorizationRequestRow } from './index.ts'

const NOW = DateTime.unsafeNow()
const NOW_MILLIS = DateTime.toEpochMillis(NOW)

const makeRow = (overrides: Partial<AuthorizationRequestRow>): AuthorizationRequestRow => ({
  id: 'req',
  grantType: 'device_code',
  clientId: 'wildflower-host',
  requestedScopes: ['owner'],
  codeChallenge: null,
  codeChallengeMethod: null,
  redirectUri: null,
  clientState: null,
  userCode: 'AAAA-0000',
  preApprovedScopes: null,
  requestedAt: NOW,
  expiresAt: DateTime.addDuration(NOW, '5 minutes'),
  lastPolledAt: null,
  status: 'pending',
  grantedScopes: null,
  patient: null,
  ...overrides,
})

describe('pickActiveDeviceUserCode', () => {
  it('returns null when there are no rows', () => {
    expect(AuthorizationRequest.pickActiveDeviceUserCode([], NOW_MILLIS)).toBeNull()
  })

  it('returns the oldest non-expired userCode regardless of input order', () => {
    const newer = makeRow({
      id: 'newer',
      userCode: 'NEWR-0001',
      requestedAt: DateTime.addDuration(NOW, '1 minute'),
    })
    const older = makeRow({
      id: 'older',
      userCode: 'OLDR-0002',
      requestedAt: DateTime.subtract(NOW, { minutes: 1 }),
    })
    // Pass newest-first to prove the helper re-sorts rather than trusting order.
    expect(AuthorizationRequest.pickActiveDeviceUserCode([newer, older], NOW_MILLIS)).toBe(
      'OLDR-0002'
    )
  })

  it('skips an expired oldest row and returns the next live one', () => {
    const expiredOldest = makeRow({
      id: 'expired',
      userCode: 'EXPD-0003',
      requestedAt: DateTime.subtract(NOW, { minutes: 10 }),
      expiresAt: DateTime.subtract(NOW, { minutes: 5 }),
    })
    const liveNewer = makeRow({
      id: 'live',
      userCode: 'LIVE-0004',
      requestedAt: DateTime.subtract(NOW, { minutes: 1 }),
      expiresAt: DateTime.addDuration(NOW, '4 minutes'),
    })
    expect(
      AuthorizationRequest.pickActiveDeviceUserCode([expiredOldest, liveNewer], NOW_MILLIS)
    ).toBe('LIVE-0004')
  })

  it('returns null when every candidate is expired', () => {
    const expired = makeRow({
      userCode: 'EXPD-0005',
      requestedAt: DateTime.subtract(NOW, { minutes: 10 }),
      expiresAt: DateTime.subtract(NOW, { minutes: 5 }),
    })
    expect(AuthorizationRequest.pickActiveDeviceUserCode([expired], NOW_MILLIS)).toBeNull()
  })

  it('skips rows without a userCode', () => {
    const noCode = makeRow({
      id: 'no-code',
      userCode: null,
      requestedAt: DateTime.subtract(NOW, { minutes: 2 }),
    })
    const withCode = makeRow({ id: 'with-code', userCode: 'WITH-0006' })
    expect(AuthorizationRequest.pickActiveDeviceUserCode([noCode, withCode], NOW_MILLIS)).toBe(
      'WITH-0006'
    )
  })
})

describe('AuthorizationRequest.queries.pendingDeviceRequests$', () => {
  const freshStore = () =>
    createStorePromise({
      adapter: makeAdapter({ storage: { type: 'in-memory' } }),
      schema,
      storeId: `sanity-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      // LiveStore defaults to LogLevel.Debug in a non-production env, emitting
      // a `LiveStore shutdown complete` line on teardown. Pin to Info to keep
      // genuine warnings/errors visible without the debug noise.
      logLevel: LogLevel.Info,
    })

  it('returns only pending device-code rows, oldest first', async () => {
    const store = await freshStore()
    try {
      store.commit(
        events.deviceAuthorizationRequestStarted({
          id: 'dev-older',
          clientId: 'wildflower-host',
          requestedScopes: ['owner'],
          userCode: 'OLD-0001',
          requestedAt: DateTime.subtract(NOW, { minutes: 2 }),
          expiresAt: DateTime.addDuration(NOW, '5 minutes'),
        })
      )
      store.commit(
        events.deviceAuthorizationRequestStarted({
          id: 'dev-newer',
          clientId: 'wildflower-host',
          requestedScopes: ['owner'],
          userCode: 'NEW-0002',
          requestedAt: DateTime.subtract(NOW, { minutes: 1 }),
          expiresAt: DateTime.addDuration(NOW, '5 minutes'),
        })
      )
      // An approved device request is excluded by the status filter.
      store.commit(
        events.deviceAuthorizationRequestStarted({
          id: 'dev-approved',
          clientId: 'wildflower-host',
          requestedScopes: ['owner'],
          userCode: 'APR-0003',
          requestedAt: DateTime.subtract(NOW, { minutes: 3 }),
          expiresAt: DateTime.addDuration(NOW, '5 minutes'),
        })
      )
      store.commit(
        events.authorizationRequestApproved({
          id: 'dev-approved',
          grantedScopes: ['owner'],
          patient: null,
        })
      )
      // An authorization_code request is excluded by the grantType filter.
      store.commit(
        events.authorizationRequestStarted({
          id: 'code-1',
          clientId: 'wildflower-host',
          requestedScopes: ['owner'],
          codeChallenge: 'challenge',
          codeChallengeMethod: 'S256',
          redirectUri: 'https://example.test/cb',
          clientState: 'state',
          preApprovedScopes: null,
          requestedAt: DateTime.subtract(NOW, { minutes: 4 }),
          expiresAt: DateTime.addDuration(NOW, '5 minutes'),
        })
      )

      const rows = store.query(AuthorizationRequest.queries.pendingDeviceRequests$)
      expect(rows.map((row) => row.id)).toEqual(['dev-older', 'dev-newer'])
      expect(rows.map((row) => row.userCode)).toEqual(['OLD-0001', 'NEW-0002'])
    } finally {
      await store.shutdownPromise().catch(() => undefined)
    }
  })
})
