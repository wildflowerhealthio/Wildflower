import { arrivingSmartLaunchFrom as sharedArrivingSmartLaunchFrom } from '@wildflowerhealthio/authorization-core/smart-client'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Option } from 'effect'
import * as fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import {
  appRootRedirectUri,
  arrivingSmartLaunchFrom,
  authorizeOpenServer,
  authorizeSmartLaunch,
  PENDING_CONNECTION_KEY,
  readySmartClient,
  shouldCompleteSmartLaunch,
} from './smart-launch.ts'

const { assignMock } = vi.hoisted(() => ({ assignMock: vi.fn<(url: string) => void>() }))

/** The FHIR server the launches below sign in to, and its SMART configuration. */
const FHIR_BASE_URL = 'https://ehr.example/fhir'
const SMART_CONFIGURATION = {
  authorization_endpoint: 'https://ehr.example/oauth/authorize',
  token_endpoint: 'https://ehr.example/oauth/token',
  code_challenge_methods_supported: ['S256'],
}

/** The app's registration and the server it launches against. */
const LAUNCH_CONFIG = {
  clientId: 'medication-app',
  scope: 'launch openid fhirUser',
  redirectUri: 'https://app.example/',
  iss: FHIR_BASE_URL,
}

/** A JSON response carrying `body`. */
const jsonResponse = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })

/**
 * The FHIR server's side of the wire: its SMART configuration (`configuration`
 * overriding fields of {@link SMART_CONFIGURATION}) and a token endpoint that
 * answers `tokenResponse`, recording every request made of it.
 */
const stubServer = (
  configuration: Record<string, unknown> = {},
  tokenResponse: unknown = { access_token: 'token-1', token_type: 'Bearer', patient: 'pat-1' }
): { readonly requests: Request[] } => {
  const requests: Request[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>((input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      return Promise.resolve(
        request.url.endsWith('/.well-known/smart-configuration')
          ? jsonResponse({ ...SMART_CONFIGURATION, ...configuration })
          : jsonResponse(tokenResponse)
      )
    })
  )
  return { requests }
}

/** Stub the page's `location` as one served over `protocol`, recording `assign`. */
const stubPageLocation = (protocol: 'http:' | 'https:'): void => {
  vi.stubGlobal('location', { protocol, href: `${protocol}//app.example/`, assign: assignMock })
}

/** The URL the page was last sent to. */
const assignedUrl = (): URL => {
  const url = assignMock.mock.lastCall?.[0]
  if (url === undefined) throw new Error('the page was not sent anywhere')
  return new URL(url)
}

/** Put the page back at `search` on the redirect target, with its real `location`. */
const returnToRedirectTarget = (search: string): void => {
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', `/${search}`)
}

beforeEach(() => {
  vi.clearAllMocks()
  window.sessionStorage.clear()
  window.history.replaceState(null, '', '/')
  stubPageLocation('https:')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('authorizeSmartLaunch', () => {
  it('should send the page to the discovered authorize endpoint with the app’s registration', async () => {
    // Arrange
    const { requests } = stubServer()

    // Act
    await authorizeSmartLaunch(LAUNCH_CONFIG, 'launch-1')

    // Assert
    expect(requests.map((request) => request.url)).toEqual([
      'https://ehr.example/fhir/.well-known/smart-configuration',
    ])
    const authorizeUrl = assignedUrl()
    expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(
      SMART_CONFIGURATION.authorization_endpoint
    )
    expect(Object.fromEntries(authorizeUrl.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'medication-app',
      scope: 'launch openid fhirUser',
      redirect_uri: 'https://app.example/',
      aud: FHIR_BASE_URL,
      launch: 'launch-1',
      code_challenge_method: 'S256',
    })
  })

  it('should send no launch for a standalone launch', async () => {
    // Arrange
    stubServer()

    // Act
    await authorizeSmartLaunch(LAUNCH_CONFIG, undefined)

    // Assert
    expect(assignedUrl().searchParams.has('launch')).toBe(false)
  })

  it('should discover under the FHIR base with its trailing slashes trimmed', async () => {
    // Arrange
    const { requests } = stubServer()

    // Act
    await authorizeSmartLaunch({ ...LAUNCH_CONFIG, iss: `${FHIR_BASE_URL}//` }, undefined)

    // Assert
    expect(requests[0]?.url).toBe('https://ehr.example/fhir/.well-known/smart-configuration')
    expect(assignedUrl().searchParams.get('aud')).toBe(FHIR_BASE_URL)
  })

  it('should send the page to a loopback http authorize endpoint from an https page', async () => {
    // Arrange — a desktop host's authorization server on this computer
    stubServer({
      authorization_endpoint: 'http://127.0.0.1:8080/oauth/authorize',
      token_endpoint: 'http://127.0.0.1:8080/oauth/token',
    })

    // Act
    await authorizeSmartLaunch(LAUNCH_CONFIG, undefined)

    // Assert
    expect(assignedUrl().origin).toBe('http://127.0.0.1:8080')
  })

  it.each([
    { case: 'a javascript: endpoint', authorizationEndpoint: 'javascript:alert(document.domain)' },
    {
      case: 'an endpoint with userinfo',
      authorizationEndpoint: 'https://user:pw@ehr.example/oauth/authorize',
    },
    {
      case: 'an endpoint with a fragment',
      authorizationEndpoint: 'https://ehr.example/oauth/authorize#here',
    },
    {
      case: 'a plain-http endpoint off loopback from an https page',
      authorizationEndpoint: 'http://ehr.example/oauth/authorize',
    },
  ])(
    'should reject naming the reason, and not navigate, for $case',
    async ({ authorizationEndpoint }) => {
      // Arrange
      stubServer({ authorization_endpoint: authorizationEndpoint })

      // Act
      const launch = authorizeSmartLaunch(LAUNCH_CONFIG, undefined)

      // Assert
      await expect(launch).rejects.toThrow('does not advertise a usable authorization_endpoint')
      expect(assignMock).not.toHaveBeenCalled()
      expect(window.sessionStorage.getItem(PENDING_CONNECTION_KEY)).toBeNull()
    }
  )

  it('should send the page to a plain-http authorize endpoint when the page is itself http', async () => {
    // Arrange — a LAN dev server, where the browser blocks nothing
    stubPageLocation('http:')
    stubServer({
      authorization_endpoint: 'http://ehr.example/oauth/authorize',
      token_endpoint: 'http://ehr.example/oauth/token',
    })

    // Act
    await authorizeSmartLaunch(LAUNCH_CONFIG, undefined)

    // Assert
    expect(assignedUrl().origin).toBe('http://ehr.example')
  })
})

describe('authorizeOpenServer', () => {
  it('should send the page straight to the redirect target, carrying a state', async () => {
    // Act
    await authorizeOpenServer({
      fhirServiceUrl: 'https://open.example/fhir/',
      redirectUri: 'https://app.example/',
    })

    // Assert
    const target = assignedUrl()
    expect(`${target.origin}${target.pathname}`).toBe('https://app.example/')
    expect(target.searchParams.get('state')).not.toBeNull()
  })
})

describe('readySmartClient', () => {
  it('should redeem a SMART return into a client for the server, with its token and patient', async () => {
    // Arrange — a launch out, then the authorization server's return
    stubServer()
    await authorizeSmartLaunch(LAUNCH_CONFIG, 'launch-1')
    const state = assignedUrl().searchParams.get('state') ?? ''
    returnToRedirectTarget(`?code=code-1&state=${state}&utm=kept`)
    const { requests } = stubServer()

    // Act
    const client = await readySmartClient()

    // Assert
    expect({
      serverUrl: client.serverUrl,
      accessToken: client.accessToken,
      launchPatientId: client.launchPatientId,
    }).toEqual({
      serverUrl: FHIR_BASE_URL,
      accessToken: 'token-1',
      launchPatientId: Option.some('pat-1'),
    })
    const [tokenRequest] = requests
    expect(tokenRequest?.url).toBe(SMART_CONFIGURATION.token_endpoint)
    const tokenRequestBody = new URLSearchParams(await tokenRequest?.text())
    expect(tokenRequestBody.get('code')).toBe('code-1')
    expect(tokenRequestBody.get('client_id')).toBe('medication-app')
    expect(tokenRequestBody.get('redirect_uri')).toBe('https://app.example/')
    expect(window.location.search).toBe('?utm=kept')
  })

  it('should connect an open server with no token', async () => {
    // Arrange
    await authorizeOpenServer({
      fhirServiceUrl: 'https://open.example/fhir/',
      redirectUri: 'https://app.example/',
    })
    returnToRedirectTarget(`?state=${assignedUrl().searchParams.get('state') ?? ''}`)

    // Act
    const client = await readySmartClient()

    // Assert
    expect({ serverUrl: client.serverUrl, accessToken: client.accessToken }).toEqual({
      serverUrl: 'https://open.example/fhir',
      accessToken: undefined,
    })
    expect(window.location.search).toBe('')
  })

  it('should refuse an open server’s return with the wrong state', async () => {
    // Arrange
    await authorizeOpenServer({
      fhirServiceUrl: 'https://open.example/fhir',
      redirectUri: 'https://app.example/',
    })
    returnToRedirectTarget('?state=forged')

    // Act / Assert
    await expect(readySmartClient()).rejects.toThrow('wrong state parameter')
  })

  it('should refuse a page with no connection in progress', async () => {
    // Arrange
    returnToRedirectTarget('?code=code-1&state=xyz')

    // Act / Assert
    await expect(readySmartClient()).rejects.toThrow('no connection in progress')
  })

  it('should complete a connection once: a second completion finds nothing to complete', async () => {
    // Arrange
    await authorizeOpenServer({
      fhirServiceUrl: 'https://open.example/fhir',
      redirectUri: 'https://app.example/',
    })
    const search = `?state=${assignedUrl().searchParams.get('state') ?? ''}`
    returnToRedirectTarget(search)
    await readySmartClient()
    window.history.replaceState(null, '', `/${search}`)

    // Act / Assert
    await expect(readySmartClient()).rejects.toThrow('no connection in progress')
  })

  it('should reject with the token endpoint’s refusal', async () => {
    // Arrange
    stubServer()
    await authorizeSmartLaunch(LAUNCH_CONFIG, undefined)
    const state = assignedUrl().searchParams.get('state') ?? ''
    returnToRedirectTarget(`?code=code-1&state=${state}`)
    stubServer({}, { error: 'invalid_grant' })

    // Act / Assert
    await expect(readySmartClient()).rejects.toThrow('invalid_grant')
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
