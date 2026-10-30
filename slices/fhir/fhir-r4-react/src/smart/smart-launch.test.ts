import { arrivingSmartLaunchFrom as sharedArrivingSmartLaunchFrom } from '@wildflowerhealthio/authorization-core/smart-client'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import type Client from 'fhirclient/Client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import {
  appRootRedirectUri,
  arrivingSmartLaunchFrom,
  authorizeSmartLaunch,
  readySmartClient,
  shouldCompleteSmartLaunch,
} from './smart-launch.ts'

// `smart-launch.ts` loads fhirclient lazily (`(await import('fhirclient/browser')).default`)
// and drives `.oauth2`, so the module boundary is where we stub. Only `authorize`
// and `ready` are exercised. `vi.hoisted` builds the spies before the import is
// wired so the factory can reference them, and typing `authorize`'s parameter as a
// record lets the tests inspect exactly which keys were passed. Asked with
// `noRedirect`, fhirclient's `authorize` resolves to the URL it would have
// navigated to; the stub answers a well-formed one unless a test says otherwise.
const { authorizeMock, readyMock, assignMock } = vi.hoisted(() => ({
  authorizeMock: vi.fn<(params: Record<string, unknown>) => Promise<string | void>>(),
  readyMock: vi.fn<() => Promise<Client>>(),
  assignMock: vi.fn<(url: string) => void>(),
}))

vi.mock('fhirclient/browser', () => ({
  default: { oauth2: { authorize: authorizeMock, ready: readyMock } },
}))

/** An authorize URL as fhirclient builds it from a well-formed endpoint. */
const AUTHORIZE_URL =
  'https://ehr.example/oauth/authorize?response_type=code&client_id=medication-app&state=xyz'

beforeEach(() => {
  vi.clearAllMocks()
  authorizeMock.mockResolvedValue(AUTHORIZE_URL)
  // The navigation is the subject, so the page's `location` is the stub: an
  // https page, whose `assign` records where it was sent.
  stubPageLocation('https:')
})

afterEach(() => {
  vi.unstubAllGlobals()
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

describe('authorizeSmartLaunch navigation', () => {
  it('should ask fhirclient for the authorize URL rather than let it navigate', async () => {
    // Act
    await authorizeSmartLaunch({ clientId: 'medication-app', scope: 'launch' })

    // Assert
    expect(authorizeArg()).toHaveProperty('noRedirect', true)
  })

  it('should send the page to a well-formed authorize URL', async () => {
    // Act
    await authorizeSmartLaunch({ clientId: 'medication-app', scope: 'launch' })

    // Assert
    expect(assignMock).toHaveBeenCalledTimes(1)
    expect(assignMock).toHaveBeenCalledWith(AUTHORIZE_URL)
  })

  it('should send the page to a loopback http authorize URL from an https page', async () => {
    // Arrange — a desktop host's authorization server on this computer
    const loopbackUrl = 'http://127.0.0.1:8080/oauth/authorize?state=xyz'
    authorizeMock.mockResolvedValue(loopbackUrl)

    // Act
    await authorizeSmartLaunch({ clientId: 'medication-app', scope: 'launch' })

    // Assert
    expect(assignMock).toHaveBeenCalledWith(loopbackUrl)
  })

  it.each([
    {
      case: 'a javascript: endpoint',
      authorizeUrl: 'javascript:alert(document.domain)//?response_type=code',
      reason: 'It is a javascript: URL, not an http or https one.',
    },
    {
      case: 'an endpoint with userinfo',
      authorizeUrl: 'https://user:pw@ehr.example/oauth/authorize?state=xyz',
      reason: 'It carries a user name or password.',
    },
    {
      case: 'an endpoint with a fragment',
      authorizeUrl: 'https://ehr.example/oauth/authorize#here?state=xyz',
      reason: 'It carries a fragment',
    },
    {
      case: 'a plain-http endpoint off loopback from an https page',
      authorizeUrl: 'http://ehr.example/oauth/authorize?state=xyz',
      reason: 'It is plain http to a host off this computer',
    },
  ])(
    'should reject naming the reason, and not navigate, for $case',
    async ({ authorizeUrl, reason }) => {
      // Arrange
      authorizeMock.mockResolvedValue(authorizeUrl)

      // Act
      const launch = authorizeSmartLaunch({ clientId: 'medication-app', scope: 'launch' })

      // Assert
      await expect(launch).rejects.toThrow(reason)
      expect(assignMock).not.toHaveBeenCalled()
    }
  )

  it('should send the page to a plain-http authorize URL when the page is itself http', async () => {
    // Arrange — a LAN dev server, where the browser blocks nothing
    stubPageLocation('http:')
    const plainUrl = 'http://ehr.example/oauth/authorize?state=xyz'
    authorizeMock.mockResolvedValue(plainUrl)

    // Act
    await authorizeSmartLaunch({ clientId: 'medication-app', scope: 'launch' })

    // Assert
    expect(assignMock).toHaveBeenCalledWith(plainUrl)
  })

  it('should reject, and not navigate, when fhirclient hands back no URL', async () => {
    // Arrange
    authorizeMock.mockResolvedValue(undefined)

    // Act
    const launch = authorizeSmartLaunch({ clientId: 'medication-app', scope: 'launch' })

    // Assert
    await expect(launch).rejects.toThrow('no authorize URL')
    expect(assignMock).not.toHaveBeenCalled()
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

describe('shouldCompleteSmartLaunch', () => {
  it('should run the app on a SMART return (code + state)', () => {
    // Act / Assert — the redirect target completes this handshake.
    expect(shouldCompleteSmartLaunch('?code=abc&state=xyz')).toBe(true)
  })

  it('should run the app on an open-server return (state, no code)', () => {
    // Act / Assert — an open-server launch redirects back with only `state`.
    expect(shouldCompleteSmartLaunch('?state=xyz')).toBe(true)
  })

  it('should show the connect menu on a bare visit', () => {
    // Act / Assert — no callback params → nothing to complete.
    expect(shouldCompleteSmartLaunch('')).toBe(false)
  })

  it('should show the connect menu when the query carries only unrelated params', () => {
    // Act / Assert
    expect(shouldCompleteSmartLaunch('?utm_source=email')).toBe(false)
  })

  it('should show the connect menu on an OAuth error return, despite its state', () => {
    // Act / Assert — a denied/expired auth carries `state` but must not be
    // completed; it routes back to the menu to retry.
    expect(shouldCompleteSmartLaunch('?error=access_denied&state=xyz')).toBe(false)
  })

  it('should run the app whenever code or state is present and error is absent', () => {
    fc.assert(
      fc.property(
        fc.subarray(['code', 'state'], { minLength: 1 }),
        fc.string(),
        fc.string(),
        nonCallbackParams(),
        (present, codeValue, stateValue, noise) => {
          // Arrange — at least one of code/state, plus arbitrary unrelated params.
          const params = { ...noise }
          if (present.includes('code')) params['code'] = codeValue
          if (present.includes('state')) params['state'] = stateValue

          // Act / Assert
          expect(shouldCompleteSmartLaunch(searchFrom(params))).toBe(true)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should never run the app when an error param is present', () => {
    fc.assert(
      fc.property(fc.string(), fc.dictionary(fc.string(), fc.string()), (errorValue, others) => {
        // Arrange — an `error` return, regardless of any code/state alongside it.
        const params = { ...others, error: errorValue }

        // Act / Assert
        expect(shouldCompleteSmartLaunch(searchFrom(params))).toBe(false)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should never run the app without code or state', () => {
    fc.assert(
      fc.property(nonCallbackParams(), (noise) => {
        // Act / Assert — no code/state/error at all → the connect menu.
        expect(shouldCompleteSmartLaunch(searchFrom(noise))).toBe(false)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// `arrivingSmartLaunchFrom`'s own behaviour is covered where it lives, in
// `authorization-core/smart-client`'s `arriving-launch.test.ts`; re-exporting is
// only worth anything if it is genuinely the same function.
describe('arrivingSmartLaunchFrom', () => {
  it('is the one implementation authorization-core owns, not a local copy', () => {
    expect(arrivingSmartLaunchFrom).toBe(sharedArrivingSmartLaunchFrom)
  })
})

describe('appRootRedirectUri', () => {
  it('should name the app root from a launch it was opened with, dropping the launch', () => {
    // Act / Assert — the EHR launch starts at the app root itself
    expect(
      appRootRedirectUri(
        'https://importer.wildflowerhealth.io/?iss=https%3A%2F%2Fehr.example&launch=xyz'
      )
    ).toBe('https://importer.wildflowerhealth.io/')
  })

  it('should name the app root itself from a page at the root, dropping its query and fragment', () => {
    // Act / Assert — the connect menu, and a callback carrying code/state
    expect(appRootRedirectUri('https://importer.wildflowerhealth.io/')).toBe(
      'https://importer.wildflowerhealth.io/'
    )
    expect(appRootRedirectUri('https://importer.wildflowerhealth.io/?code=abc&state=xyz#x')).toBe(
      'https://importer.wildflowerhealth.io/'
    )
  })

  it('should keep a dev server’s origin, over plain http off loopback too', () => {
    // Act / Assert — no scheme screen: a LAN dev server derives its own root
    expect(appRootRedirectUri('http://127.0.0.1:5191/?iss=x')).toBe('http://127.0.0.1:5191/')
    expect(appRootRedirectUri('http://192.168.1.20:5191/')).toBe('http://192.168.1.20:5191/')
  })

  it('should name the served directory from a deep route of a routed app', () => {
    // Act / Assert — a launch at a nested route returns to the app root
    expect(
      appRootRedirectUri('https://apps.example/pr-7/patients/123/today?iss=x&launch=y#z', '/pr-7/')
    ).toBe('https://apps.example/pr-7/')
    expect(appRootRedirectUri('https://u:p@apps.example/patients/1.50/plan', '/')).toBe(
      'https://u:p@apps.example/'
    )
  })

  it('should give every page in one directory, whatever it carries, the same root', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('', 'index.html'),
        nonCallbackParams(),
        fc.string(),
        (page, params, fragment) => {
          // Arrange
          const href = `https://apps.example/some/app/${page}${searchFrom(params)}#${encodeURIComponent(fragment)}`

          // Act / Assert
          expect(appRootRedirectUri(href)).toBe('https://apps.example/some/app/')
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

/**
 * The three params that mark a return from the authorization server, which
 * `shouldCompleteSmartLaunch` keys off, excluded from noise.
 */
const CALLBACK_PARAMS = ['code', 'state', 'error']

/** A query string built from `params`, leading `?` included. */
const searchFrom = (params: Record<string, string>): string =>
  `?${new URLSearchParams(params).toString()}`

/** Arbitrary query params that are never `code`, `state`, or `error`. */
const nonCallbackParams = (): fc.Arbitrary<Record<string, string>> =>
  fc.dictionary(fc.string(), fc.string()).map((dict) => {
    const copy = { ...dict }
    for (const key of CALLBACK_PARAMS) delete copy[key]
    return copy
  })

/** The options object `authorize` was called with on its first (only) invocation. */
const authorizeArg = (): Record<string, unknown> => {
  const call = authorizeMock.mock.calls[0]
  if (call === undefined) {
    throw new Error('authorize was not called')
  }
  return call[0]
}

/** Stub the page's `location` as a page served over `protocol`, recording `assign`. */
const stubPageLocation = (protocol: 'http:' | 'https:'): void => {
  vi.stubGlobal('location', { protocol, assign: assignMock })
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
