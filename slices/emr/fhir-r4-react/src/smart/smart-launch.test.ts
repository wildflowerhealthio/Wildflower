import * as fc from 'fast-check'
import type Client from 'fhirclient/lib/Client'
import { numRunsFor } from 'kitchen-sink/test'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { authorizeSmartLaunch, readySmartClient } from './smart-launch.ts'

// `smart-launch.ts` loads fhirclient lazily (`(await import('fhirclient')).default`)
// and drives `.oauth2`, so the module boundary is where we stub. Only `authorize`
// and `ready` are exercised. `vi.hoisted` builds the spies before the import is
// wired so the factory can reference them, and typing `authorize`'s parameter as a
// record lets the tests inspect exactly which keys were passed.
const { authorizeMock, readyMock } = vi.hoisted(() => ({
  authorizeMock: vi.fn<(params: Record<string, unknown>) => Promise<void>>(() => Promise.resolve()),
  readyMock: vi.fn<() => Promise<Client>>(),
}))

vi.mock('fhirclient', () => ({
  default: { oauth2: { authorize: authorizeMock, ready: readyMock } },
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('authorizeSmartLaunch', () => {
  it('should forward the clientId and scope to fhirclient', async () => {
    // Act
    await authorizeSmartLaunch({ clientId: 'medication-app', scope: 'launch openid fhirUser' })

    // Assert
    expect(authorizeMock).toHaveBeenCalledTimes(1)
    expect(authorizeArg()).toMatchObject({
      clientId: 'medication-app',
      scope: 'launch openid fhirUser',
    })
  })

  it('should omit redirectUri and iss entirely when they are not configured', async () => {
    // Act — an EHR launch reads iss/launch from the URL, so neither is passed.
    await authorizeSmartLaunch({ clientId: 'medication-app', scope: 'launch' })

    // Assert — the keys must be absent, not present-with-`undefined`: fhirclient
    // distinguishes an omitted option from one explicitly set to `undefined`.
    expect(authorizeArg()).not.toHaveProperty('redirectUri')
    expect(authorizeArg()).not.toHaveProperty('iss')
  })

  it('should include redirectUri and iss when both are configured', async () => {
    // Act — a standalone launch names its own redirect target and FHIR server.
    await authorizeSmartLaunch({
      clientId: 'medication-app',
      scope: 'launch/patient',
      redirectUri: '/index.html',
      iss: 'https://example.org/fhir-r4',
    })

    // Assert
    expect(authorizeArg()).toMatchObject({
      redirectUri: '/index.html',
      iss: 'https://example.org/fhir-r4',
    })
  })

  it('should include each optional field iff it is defined, never present-with-undefined', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.string(),
        fc.option(fc.string(), { nil: undefined }),
        fc.option(fc.string(), { nil: undefined }),
        async (clientId, scope, redirectUri, iss) => {
          // Arrange
          authorizeMock.mockClear()

          // Act — an omitted field is modeled as `undefined`, which the code must
          // treat the same as absent (the `... ? {} : {...}` spreads).
          await authorizeSmartLaunch({ clientId, scope, redirectUri, iss })

          // Assert
          const arg = authorizeArg()
          expect(arg).toMatchObject({ clientId, scope })
          assertOptionalKey(arg, 'redirectUri', redirectUri)
          assertOptionalKey(arg, 'iss', iss)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('readySmartClient', () => {
  it('should resolve to the client fhirclient hands back after the exchange', async () => {
    // Arrange
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test-only sentinel; the value is only checked for identity
    const readyClient = { id: 'ready' } as unknown as Client
    readyMock.mockResolvedValue(readyClient)

    // Act
    const client = await readySmartClient()

    // Assert
    expect(readyMock).toHaveBeenCalledTimes(1)
    expect(client).toBe(readyClient)
  })
})

// Helpers

/** The options object `authorize` was called with on its first (only) invocation. */
const authorizeArg = (): Record<string, unknown> => {
  const call = authorizeMock.mock.calls[0]
  if (call === undefined) {
    throw new Error('authorize was not called')
  }
  return call[0]
}

/** Assert `key` is present with `value` when defined, and absent otherwise. */
const assertOptionalKey = (
  arg: Record<string, unknown>,
  key: 'redirectUri' | 'iss',
  value: string | undefined
): void => {
  if (value === undefined) {
    expect(arg).not.toHaveProperty(key)
  } else {
    expect(arg).toHaveProperty(key, value)
  }
}
