/**
 * The two ends of a SMART sign-in's redirect, for the tests of both: the FHIR
 * server's side of the wire over a stubbed `fetch`, and the page's `location`,
 * recording where it was sent.
 *
 * @packageDocumentation
 */
import type { SignInServices } from '@wildflowerhealthio/authorization-core/smart-client'
import { Effect, Match } from 'effect'
import { vi } from 'vite-plus/test'

import {
  RETAINED_SELF_ADDRESSED_SIGN_IN_REQUEST_KEY,
  RETAINED_SIGN_IN_REQUEST_KEY,
  smartSignInLayer,
} from './retained-sign-in-requests.ts'
import { rootArrivalFrom, type SignInArrival } from './root-arrival.ts'
import { redirectToSelfAddressedSignInReturn, type SmartLaunchConfig } from './sign-in-redirect.ts'
import { decodeFhirBaseUrl } from './smart-connection.ts'
import { redirectToSignIn } from './smart-support.ts'

/** The page's `location.assign`, recording where the page was sent. */
const assignMock = vi.fn<(url: string) => void>()

/** The FHIR server the launches below sign in to, and its SMART configuration. */
const FHIR_BASE_URL = decodeFhirBaseUrl('https://ehr.example/fhir')
const SMART_CONFIGURATION = {
  authorization_endpoint: 'https://ehr.example/oauth/authorize',
  token_endpoint: 'https://ehr.example/oauth/token',
  code_challenge_methods_supported: ['S256'],
}

/** The app's registration. */
const REGISTRATION = { clientId: 'medication-app', scope: 'launch openid fhirUser' }

/**
 * The app root the redirect target is served at: the test page's own root, so
 * the return leg derives the same redirect URI the launch sent.
 */
const APP_ROOT = new URL('/', window.location.href).href

/** The app's registration and the server it launches against. */
const LAUNCH_CONFIG: SmartLaunchConfig = {
  ...REGISTRATION,
  redirectUri: APP_ROOT,
  fhirBaseUrl: FHIR_BASE_URL,
}

/** A self-addressed sign-in to an open server, sent back to the app root. */
const SELF_ADDRESSED_CONFIG = {
  fhirBaseUrl: decodeFhirBaseUrl('https://open.example/fhir/'),
  redirectUri: APP_ROOT,
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

/** A fresh page at the app root, served over https, holding no retained request. */
const resetPage = (): void => {
  vi.clearAllMocks()
  window.sessionStorage.clear()
  window.history.replaceState(null, '', '/')
  stubPageLocation('https:')
}

/** `effect` on this page's sign-in services, as the app's edges provide them. */
const onThisPage = <A, E>(effect: Effect.Effect<A, E, SignInServices>): Effect.Effect<A, E> =>
  Effect.provide(effect, smartSignInLayer(window))

/** Start a sign-in out of the page, returning the `state` it sent. */
const signInOut = async (): Promise<string> => {
  stubServer()
  await Effect.runPromise(onThisPage(redirectToSignIn(LAUNCH_CONFIG, 'launch-1')))
  return assignedUrl().searchParams.get('state') ?? ''
}

/** Start a self-addressed sign-in out of the page, returning the `state` it sent. */
const selfAddressedSignInOut = async (): Promise<string> => {
  await Effect.runPromise(onThisPage(redirectToSelfAddressedSignInReturn(SELF_ADDRESSED_CONFIG)))
  return assignedUrl().searchParams.get('state') ?? ''
}

/** The retained sign-in requests the page still holds, by key. */
const retainedRequests = (): Record<string, string | null> => ({
  signIn: window.sessionStorage.getItem(RETAINED_SIGN_IN_REQUEST_KEY),
  selfAddressed: window.sessionStorage.getItem(RETAINED_SELF_ADDRESSED_SIGN_IN_REQUEST_KEY),
})

const NO_RETAINED_REQUESTS = { signIn: null, selfAddressed: null }

/** Throw as a blocked storage does on every call. */
const blocked = (): never => {
  throw new DOMException('The operation is insecure.', 'SecurityError')
}

/** A `sessionStorage` whose every call throws, as a blocked one does. */
const stubBlockedStorage = (): void => {
  vi.stubGlobal('sessionStorage', { getItem: blocked, setItem: blocked, removeItem: blocked })
}

/**
 * Stub the page's storage as one that holds what the real one does but throws
 * on every removal, and on a read of any key in `unreadableKeys`.
 */
const stubStorageRefusing = (unreadableKeys: readonly string[] = []): void => {
  const store = window.sessionStorage
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => (unreadableKeys.includes(key) ? blocked() : store.getItem(key)),
    setItem: (key: string, value: string) => store.setItem(key, value),
    removeItem: blocked,
  })
}

/** The sign-in arrival the page's own query string is; throws on any other. */
const signInArrivalHere = (): SignInArrival =>
  Match.value(rootArrivalFrom(window.location.search)).pipe(
    Match.tag('SignInReturn', 'SelfAddressedSignInReturn', (arrival) => arrival),
    Match.orElse((arrival) => {
      throw new Error(`the page arrived as ${arrival._tag}, no sign-in`)
    })
  )

export {
  APP_ROOT,
  assignedUrl,
  FHIR_BASE_URL,
  jsonResponse,
  LAUNCH_CONFIG,
  NO_RETAINED_REQUESTS,
  onThisPage,
  REGISTRATION,
  resetPage,
  retainedRequests,
  returnToRedirectTarget,
  SELF_ADDRESSED_CONFIG,
  selfAddressedSignInOut,
  signInArrivalHere,
  signInOut,
  SMART_CONFIGURATION,
  stubBlockedStorage,
  stubServer,
  stubStorageRefusing,
}
