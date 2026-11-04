import { Effect, Option } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import {
  RETAINED_SELF_ADDRESSED_SIGN_IN_REQUEST_KEY,
  RETAINED_SIGN_IN_REQUEST_KEY,
} from './retained-sign-in-requests.ts'
import {
  redirectToSelfAddressedSignInReturn,
  redirectToSignIn,
  redirectToSignInAt,
} from './sign-in-redirect.ts'
import {
  APP_ROOT,
  assignedUrl,
  assignMock,
  FHIR_BASE_URL,
  LAUNCH_CONFIG,
  REGISTRATION,
  resetPage,
  SMART_CONFIGURATION,
  stubPageLocation,
  stubServer,
} from './sign-in.test-helpers.ts'
import { decodeFhirBaseUrl } from './smart-connection.ts'

beforeEach(resetPage)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('redirectToSignIn', () => {
  it('should send the page to the discovered authorize endpoint with the app’s registration', async () => {
    // Arrange
    const { requests } = stubServer()

    // Act
    await Effect.runPromise(redirectToSignIn(LAUNCH_CONFIG, 'launch-1'))

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
      redirect_uri: APP_ROOT,
      aud: FHIR_BASE_URL,
      launch: 'launch-1',
      code_challenge_method: 'S256',
    })
  })

  it('should send no launch for a standalone launch', async () => {
    // Arrange
    stubServer()

    // Act
    await Effect.runPromise(redirectToSignIn(LAUNCH_CONFIG, undefined))

    // Assert
    expect(assignedUrl().searchParams.has('launch')).toBe(false)
  })

  it('should discover under the FHIR base with its trailing slashes trimmed', async () => {
    // Arrange
    const { requests } = stubServer()

    // Act
    await Effect.runPromise(
      redirectToSignIn(
        { ...LAUNCH_CONFIG, fhirBaseUrl: decodeFhirBaseUrl(`${FHIR_BASE_URL}//`) },
        undefined
      )
    )

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
    await Effect.runPromise(redirectToSignIn(LAUNCH_CONFIG, undefined))

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
    'should fail naming the reason, and not navigate, for $case',
    async ({ authorizationEndpoint }) => {
      // Arrange
      stubServer({ authorization_endpoint: authorizationEndpoint })

      // Act
      const failure = await Effect.runPromise(
        Effect.flip(redirectToSignIn(LAUNCH_CONFIG, undefined))
      )

      // Assert
      expect(failure.reason).toContain('does not advertise a usable authorization_endpoint')
      expect(assignMock).not.toHaveBeenCalled()
      expect(window.sessionStorage.getItem(RETAINED_SIGN_IN_REQUEST_KEY)).toBeNull()
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
    await Effect.runPromise(redirectToSignIn(LAUNCH_CONFIG, undefined))

    // Assert
    expect(assignedUrl().origin).toBe('http://ehr.example')
  })
})

describe('redirectToSignInAt', () => {
  it('should send the page to the discovered authorize endpoint without discovering it again', async () => {
    // Arrange
    const { requests } = stubServer()

    // Act
    await Effect.runPromise(
      redirectToSignInAt(
        {
          smartServer: { _tag: 'PlainSmartServer', fhirBaseUrl: FHIR_BASE_URL },
          endpoints: {
            authorizationEndpoint: SMART_CONFIGURATION.authorization_endpoint,
            tokenEndpoint: SMART_CONFIGURATION.token_endpoint,
          },
          managementEndpoint: Option.none(),
          wildflowerAuthorizationApi: Option.none(),
        },
        { ...REGISTRATION, redirectUri: APP_ROOT }
      )
    )

    // Assert
    expect(requests).toEqual([])
    const authorizeUrl = assignedUrl()
    expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(
      SMART_CONFIGURATION.authorization_endpoint
    )
    expect(authorizeUrl.searchParams.get('aud')).toBe(FHIR_BASE_URL)
    expect(authorizeUrl.searchParams.has('launch')).toBe(false)
    expect(window.sessionStorage.getItem(RETAINED_SIGN_IN_REQUEST_KEY)).not.toBeNull()
  })
})

describe('redirectToSelfAddressedSignInReturn', () => {
  it('should send the page straight back to itself, carrying the state it retained', async () => {
    // Act
    await Effect.runPromise(
      redirectToSelfAddressedSignInReturn({
        fhirBaseUrl: decodeFhirBaseUrl('https://open.example/fhir/'),
        redirectUri: 'https://app.example/',
      })
    )

    // Assert
    const target = assignedUrl()
    expect(`${target.origin}${target.pathname}`).toBe('https://app.example/')
    expect(
      JSON.parse(window.sessionStorage.getItem(RETAINED_SELF_ADDRESSED_SIGN_IN_REQUEST_KEY) ?? '')
    ).toEqual({
      expectedState: target.searchParams.get('state'),
      fhirBaseUrl: 'https://open.example/fhir',
    })
  })
})
