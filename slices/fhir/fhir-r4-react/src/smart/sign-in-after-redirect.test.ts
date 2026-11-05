import type { PendingRequestUnusable } from '@wildflowerhealthio/authorization-core/smart-client'
import { Data, Effect, Match, Option } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { RETAINED_SELF_ADDRESSED_SIGN_IN_REQUEST_KEY } from './retained-sign-in-requests.ts'
import { rootArrivalFrom } from './root-arrival.ts'
import {
  CallbackStateMismatch,
  completeSignInAfterRedirectHere,
  discardRefusedSignInAfterRedirectHere,
  NoSignInInProgress,
  type SignInAfterRedirectError,
} from './sign-in-after-redirect.ts'
import { redirectToSignIn } from './sign-in-redirect.ts'
import {
  APP_ROOT,
  assignedUrl,
  FHIR_BASE_URL,
  LAUNCH_CONFIG,
  NO_RETAINED_REQUESTS,
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
} from './sign-in.test-helpers.ts'
import { SmartConnection } from './smart-connection.ts'

beforeEach(resetPage)

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The landing the page's own query string is, at `appRootRedirectUri`. */
const landingHere = (
  appRootRedirectUri: string = APP_ROOT
): Parameters<typeof completeSignInAfterRedirectHere>[0] => ({
  arrival: signInArrivalHere(),
  registration: REGISTRATION,
  appRootRedirectUri,
})

/** Complete the sign-in the page landed on. */
const completeHere = (appRootRedirectUri?: string): Promise<SmartConnection> =>
  Effect.runPromise(completeSignInAfterRedirectHere(landingHere(appRootRedirectUri)))

/** Why completing the sign-in the page landed on fails. */
const failureHere = (): Promise<SignInAfterRedirectError> =>
  Effect.runPromise(Effect.flip(completeSignInAfterRedirectHere(landingHere())))

/** The page arrived as something other than the sign-in a test set up. */
class UnexpectedArrival extends Data.TaggedError('UnexpectedArrival')<{
  readonly reason: string
}> {}

/** Discard the refused sign-in the page landed on. */
const discardHere = (): Effect.Effect<void, PendingRequestUnusable | UnexpectedArrival> =>
  Match.value(rootArrivalFrom(window.location.search)).pipe(
    Match.tag('SignInRefused', (refused) =>
      discardRefusedSignInAfterRedirectHere(refused, {
        registration: REGISTRATION,
        appRootRedirectUri: APP_ROOT,
      })
    ),
    Match.orElse((arrival) =>
      Effect.fail(new UnexpectedArrival({ reason: `the page arrived as ${arrival._tag}` }))
    )
  )

describe('completeSignInAfterRedirectHere', () => {
  it('should redeem a sign-in return into a connection to the server, with its token and patient', async () => {
    // Arrange — a launch out, then the authorization server's return
    const state = await signInOut()
    returnToRedirectTarget(`?code=code-1&state=${state}&utm=kept`)
    const { requests } = stubServer()

    // Act
    const connection = await completeHere()

    // Assert
    expect(connection).toEqual(
      new SmartConnection({
        fhirBaseUrl: FHIR_BASE_URL,
        accessToken: Option.some('token-1'),
        launchPatientId: Option.some('pat-1'),
      })
    )
    const [tokenRequest] = requests
    expect(tokenRequest?.url).toBe(SMART_CONFIGURATION.token_endpoint)
    const tokenRequestBody = new URLSearchParams(await tokenRequest?.text())
    expect(tokenRequestBody.get('code')).toBe('code-1')
    expect(tokenRequestBody.get('client_id')).toBe('medication-app')
    expect(tokenRequestBody.get('redirect_uri')).toBe(APP_ROOT)
    expect(window.location.search).toBe('?utm=kept')
  })

  it('should redeem as the redirect URI the landing names', async () => {
    // Arrange — a routed app served under `/pr-7/`, its callback at that root
    stubServer()
    const servedRoot = new URL('/pr-7/', APP_ROOT).href
    await Effect.runPromise(
      redirectToSignIn({ ...LAUNCH_CONFIG, redirectUri: servedRoot }, undefined)
    )
    const state = assignedUrl().searchParams.get('state') ?? ''
    vi.unstubAllGlobals()
    window.history.replaceState(null, '', `/pr-7/?code=code-1&state=${state}`)
    const { requests } = stubServer()

    // Act
    await completeHere(servedRoot)

    // Assert
    const tokenRequestBody = new URLSearchParams(await requests[0]?.text())
    expect(tokenRequestBody.get('redirect_uri')).toBe(servedRoot)
  })

  it('should connect to an open server with no token on a self-addressed return', async () => {
    // Arrange
    returnToRedirectTarget(`?state=${await selfAddressedSignInOut()}`)

    // Act
    const connection = await completeHere()

    // Assert
    expect(connection).toEqual(
      new SmartConnection({
        fhirBaseUrl: SELF_ADDRESSED_CONFIG.fhirBaseUrl,
        accessToken: Option.none(),
        launchPatientId: Option.none(),
      })
    )
    expect(window.location.search).toBe('')
  })

  it('should refuse a self-addressed return with the wrong state', async () => {
    // Arrange
    await selfAddressedSignInOut()
    returnToRedirectTarget('?state=forged')

    // Act / Assert
    expect(await failureHere()).toEqual(
      new CallbackStateMismatch({
        reason: 'The sign-in came back with the wrong state parameter, so it was discarded.',
      })
    )
  })

  it('should refuse a self-addressed return with no sign-in in progress', async () => {
    // Arrange
    returnToRedirectTarget('?state=xyz')

    // Act / Assert
    expect(await failureHere()).toBeInstanceOf(NoSignInInProgress)
  })

  it('should refuse a code that comes back with no state', async () => {
    // Arrange
    await signInOut()
    returnToRedirectTarget('?code=code-1')

    // Act / Assert
    expect((await failureHere()).reason).toContain('wrong state parameter')
  })

  it('should refuse a code with no sign-in in progress', async () => {
    // Arrange
    returnToRedirectTarget('?code=code-1&state=xyz')

    // Act / Assert
    expect((await failureHere()).reason).toContain('did not ask for')
  })

  it('should complete a sign-in once: a second completion finds nothing to complete', async () => {
    // Arrange
    const search = `?state=${await selfAddressedSignInOut()}`
    returnToRedirectTarget(search)
    await completeHere()
    window.history.replaceState(null, '', `/${search}`)

    // Act / Assert
    expect(await failureHere()).toBeInstanceOf(NoSignInInProgress)
  })

  it('should take the self-addressed request on a SMART return', async () => {
    // Arrange — a self-addressed sign-in abandoned, then a sign-in that came back
    await selfAddressedSignInOut()
    const state = await signInOut()
    returnToRedirectTarget(`?code=code-1&state=${state}`)
    stubServer()

    // Act
    await completeHere()

    // Assert
    expect(retainedRequests()).toEqual(NO_RETAINED_REQUESTS)
  })

  it('should take the sign-in request on a self-addressed return', async () => {
    // Arrange — a sign-in abandoned, then a self-addressed one that came back
    await signInOut()
    const state = await selfAddressedSignInOut()
    returnToRedirectTarget(`?state=${state}`)

    // Act
    await completeHere()

    // Assert
    expect(retainedRequests()).toEqual(NO_RETAINED_REQUESTS)
  })

  it('should fail with the token endpoint’s refusal', async () => {
    // Arrange
    const state = await signInOut()
    returnToRedirectTarget(`?code=code-1&state=${state}`)
    stubServer({}, { error: 'invalid_grant' })

    // Act / Assert
    expect((await failureHere()).reason).toContain('invalid_grant')
  })

  it('should fail with the storage’s reason when storage is blocked', async () => {
    // Arrange
    returnToRedirectTarget('?state=xyz')
    stubBlockedStorage()

    // Act
    const failure = await failureHere()

    // Assert
    expect(failure).toMatchObject({ _tag: 'PendingRequestUnusable' })
    expect(failure.reason).toContain('session storage is blocked')
  })

  it('should refuse a retained request a different version of the page wrote', async () => {
    // Arrange
    window.sessionStorage.setItem(
      RETAINED_SELF_ADDRESSED_SIGN_IN_REQUEST_KEY,
      '{"_tag":"PendingOpenServer"}'
    )
    returnToRedirectTarget('?state=xyz')

    // Act / Assert
    expect((await failureHere()).reason).toContain('started by a different version of this page')
    expect(retainedRequests()).toEqual(NO_RETAINED_REQUESTS)
  })
})

describe('discardRefusedSignInAfterRedirectHere', () => {
  it('should take every retained request and scrub the refusal', async () => {
    // Arrange — both kinds of sign-in out, then the server's refusal
    await selfAddressedSignInOut()
    const state = await signInOut()
    returnToRedirectTarget(`?error=access_denied&error_description=No&state=${state}&utm=kept`)

    // Act
    await Effect.runPromise(discardHere())

    // Assert
    expect(retainedRequests()).toEqual(NO_RETAINED_REQUESTS)
    expect(window.location.search).toBe('?utm=kept')
  })

  it('should fail with the storage’s reason when storage is blocked', async () => {
    // Arrange
    returnToRedirectTarget('?error=access_denied&state=xyz')
    stubBlockedStorage()

    // Act
    const failure = await Effect.runPromise(Effect.flip(discardHere()))

    // Assert
    expect(failure.reason).toContain('session storage is blocked')
  })
})
