import type { SmartIssuer } from '@wildflowerhealthio/authorization-core/smart-client'
import { Effect, Option } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import {
  RETAINED_SELF_ADDRESSED_SIGN_IN_REQUEST_KEY,
  RETAINED_SIGN_IN_REQUEST_KEY,
} from './retained-sign-in-requests.ts'
import { redirectToSelfAddressedSignInReturn, redirectToSignInAt } from './sign-in-redirect.ts'
import {
  APP_ROOT,
  assignedUrl,
  FHIR_BASE_URL,
  REGISTRATION,
  resetPage,
  SMART_CONFIGURATION,
  stubServer,
} from './sign-in.test-helpers.ts'
import { decodeFhirBaseUrl } from './smart-connection.ts'

beforeEach(resetPage)

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The SMART server {@link SMART_CONFIGURATION} describes, as its probe discovered it. */
const DISCOVERED: SmartIssuer = {
  smartServer: { _tag: 'PlainSmartServer', fhirBaseUrl: FHIR_BASE_URL },
  endpoints: {
    authorizationEndpoint: SMART_CONFIGURATION.authorization_endpoint,
    tokenEndpoint: SMART_CONFIGURATION.token_endpoint,
  },
  managementEndpoint: Option.none(),
  wildflowerAuthorizationApi: Option.none(),
}

describe('redirectToSignInAt', () => {
  it('should send the page to the discovered authorize endpoint with the app’s registration and the launch', async () => {
    // Arrange
    const { requests } = stubServer()

    // Act
    await Effect.runPromise(
      redirectToSignInAt(DISCOVERED, { ...REGISTRATION, redirectUri: APP_ROOT }, 'launch-1')
    )

    // Assert — nothing discovered again, and the request retained for the return
    expect(requests).toEqual([])
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
    expect(window.sessionStorage.getItem(RETAINED_SIGN_IN_REQUEST_KEY)).not.toBeNull()
  })

  it('should send no launch for a standalone launch', async () => {
    // Act
    await Effect.runPromise(
      redirectToSignInAt(DISCOVERED, { ...REGISTRATION, redirectUri: APP_ROOT }, undefined)
    )

    // Assert
    expect(assignedUrl().searchParams.has('launch')).toBe(false)
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
