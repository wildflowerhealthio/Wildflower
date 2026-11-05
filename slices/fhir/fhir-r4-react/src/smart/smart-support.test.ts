import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import {
  type DiscoveredSmartServer,
  insecureTargetReason as sharedInsecureTargetReason,
  normalizeServerUrl as sharedNormalizeServerUrl,
  PageSecurity,
  RetainedRequestUnusable,
  RetainedSignInRequestStore,
  SignInCrypto,
} from '@wildflowerhealthio/authorization-core/smart-client'
import { Effect, Layer, Option, Ref } from 'effect'

import {
  RetainedSelfAddressedSignInRequestStore,
  type SmartSignInServices,
} from './retained-sign-in-requests.ts'
import type { SelfAddressedSignInConfig, SmartLaunchConfig } from './sign-in-redirect.ts'
import { decodeFhirBaseUrl } from './smart-connection.ts'
import {
  detectSmartSupport,
  insecureTargetReason,
  normalizeServerUrl,
  redirectToSignIn,
  SmartSupport,
} from './smart-support.ts'
import {
  answerEveryRequest,
  answerJson,
  answerStatus,
  answerText,
  dropRequest,
  stubFhirServer,
  type StubAnswer,
  type StubFhirServer,
} from './test-helpers.ts'

// `redirectToSignIn` hands the sign-in to `sign-in-redirect.ts`, whose own
// suite covers the sign-in and the navigation, so the module boundary is where
// we stub. `detectSmartSupport`'s tests never touch it (they answer over a
// stub `HttpClient`).
const { redirectToSignInAtMock, redirectToSelfAddressedSignInReturnMock } = vi.hoisted(() => ({
  redirectToSignInAtMock:
    vi.fn<
      (
        discovered: DiscoveredSmartServer,
        config: Omit<SmartLaunchConfig, 'fhirBaseUrl'>,
        launch: string | undefined
      ) => Effect.Effect<void, RetainedRequestUnusable>
    >(),
  redirectToSelfAddressedSignInReturnMock:
    vi.fn<(config: SelfAddressedSignInConfig) => Effect.Effect<void>>(),
}))

vi.mock('./sign-in-redirect.ts', () => ({
  redirectToSignInAt: redirectToSignInAtMock,
  redirectToSelfAddressedSignInReturn: redirectToSelfAddressedSignInReturnMock,
}))

beforeEach(() => {
  vi.clearAllMocks()
  redirectToSignInAtMock.mockReturnValue(Effect.void)
  redirectToSelfAddressedSignInReturnMock.mockReturnValue(Effect.void)
})

/**
 * The sign-in services over a stub server answering every request with
 * `answer`, on a page that is secure unless `pageIsSecure` says not, with the
 * record of what the server was sent.
 */
const servicesAnswering = (
  answer: StubAnswer,
  pageIsSecure = true
): Pick<StubFhirServer, 'requests' | 'urls'> & {
  readonly layer: Layer.Layer<SmartSignInServices>
} => {
  const server = stubFhirServer(answerEveryRequest(answer))
  return {
    layer: Layer.mergeAll(
      server.transport,
      Layer.succeed(PageSecurity, { pageIsSecure }),
      SignInCrypto.layerFromWindow(globalThis),
      RetainedSignInRequestStore.memoryBackedLayer(Ref.unsafeMake(Option.none())),
      RetainedSelfAddressedSignInRequestStore.memoryBackedLayer(Ref.unsafeMake(Option.none()))
    ),
    requests: server.requests,
    urls: server.urls,
  }
}

/** The support `fhirBaseUrl` gives, probed over a stub server answering `answer`. */
const supportOf = (
  fhirBaseUrl: string,
  answer: StubAnswer,
  pageIsSecure?: boolean
): Promise<SmartSupport> =>
  Effect.runPromise(
    Effect.provide(
      detectSmartSupport(decodeFhirBaseUrl(fhirBaseUrl)),
      servicesAnswering(answer, pageIsSecure).layer
    )
  )

/** `redirectToSignIn(config, launch)` over `services`. */
const signIn = (
  config: SmartLaunchConfig,
  launch: string | undefined,
  services: ReturnType<typeof servicesAnswering>
): Effect.Effect<SmartSupport, unknown> =>
  Effect.provide(redirectToSignIn(config, launch), services.layer)

/**
 * A SMART configuration whose endpoints are usable from an https page, shaped
 * like the SmartHealthIT sandbox's: https endpoints, and S256.
 */
const SMART_CONFIGURATION = {
  authorization_endpoint: 'https://ehr.example/authorize',
  token_endpoint: 'https://ehr.example/token',
  code_challenge_methods_supported: ['S256'],
}

/** The server {@link SMART_CONFIGURATION} describes, served at `fhirBaseUrl`. */
const discoveredAt = (fhirBaseUrl: string): Partial<DiscoveredSmartServer> => ({
  smartServer: { _tag: 'PlainSmartServer', fhirBaseUrl },
  endpoints: {
    authorizationEndpoint: SMART_CONFIGURATION.authorization_endpoint,
    tokenEndpoint: SMART_CONFIGURATION.token_endpoint,
  },
})

describe('detectSmartSupport', () => {
  it('is `Smart`, carrying the server it discovered, when the config names usable endpoints', async () => {
    const support = await supportOf('https://ehr.example/fhir', answerJson(SMART_CONFIGURATION))
    expect(support).toMatchObject({
      _tag: 'Smart',
      discovered: discoveredAt('https://ehr.example/fhir'),
    })
  })

  it.each([
    {
      case: 'a javascript: authorization_endpoint',
      configuration: { ...SMART_CONFIGURATION, authorization_endpoint: 'javascript:alert(1)' },
    },
    {
      case: 'an authorization_endpoint with userinfo',
      configuration: {
        ...SMART_CONFIGURATION,
        authorization_endpoint: 'https://user:pw@ehr.example/authorize',
      },
    },
    {
      case: 'a plain-http token_endpoint off loopback',
      configuration: { ...SMART_CONFIGURATION, token_endpoint: 'http://ehr.example/token' },
    },
  ])('is `Unusable`, with the discovery reason, for $case', async ({ configuration }) => {
    const support = await supportOf('https://ehr.example/fhir', answerJson(configuration), true)
    expect(support).toEqual({
      _tag: 'Unusable',
      reason:
        'The server’s SMART configuration does not advertise a usable ' +
        'authorization_endpoint and token_endpoint over https (or loopback).',
    })
  })

  it('is `Unusable` when the config names an authorization_endpoint but no token_endpoint', async () => {
    const support = await supportOf(
      'https://ehr.example/fhir',
      answerJson({ authorization_endpoint: 'https://ehr.example/authorize' }),
      true
    )
    expect(support).toMatchObject({ _tag: 'Unusable' })
  })

  it('is `Smart` for a loopback http endpoint from an https page', async () => {
    // A desktop host's authorization server on this computer
    const support = await supportOf(
      'https://ehr.example/fhir',
      answerJson({
        ...SMART_CONFIGURATION,
        authorization_endpoint: 'http://127.0.0.1:8080/oauth/authorize',
        token_endpoint: 'http://127.0.0.1:8080/oauth/token',
      }),
      true
    )
    expect(support).toMatchObject({ _tag: 'Smart' })
  })

  it('is `Smart` for a plain-http endpoint when the page is itself http', async () => {
    const support = await supportOf(
      'http://ehr.example/fhir',
      answerJson({
        ...SMART_CONFIGURATION,
        authorization_endpoint: 'http://ehr.example/authorize',
        token_endpoint: 'http://ehr.example/token',
      }),
      false
    )
    expect(support).toMatchObject({ _tag: 'Smart' })
  })

  it('probes the well-known path under the decoded FHIR base, its trailing slash trimmed', async () => {
    const services = servicesAnswering(answerJson(SMART_CONFIGURATION))
    await Effect.runPromise(
      Effect.provide(
        detectSmartSupport(decodeFhirBaseUrl('https://ehr.example/fhir/')),
        services.layer
      )
    )
    expect(services.urls).toEqual(['https://ehr.example/fhir/.well-known/smart-configuration'])
  })

  it('sends the probe with no trace headers, so it stays a CORS-simple request', async () => {
    const services = servicesAnswering(answerJson(SMART_CONFIGURATION))
    await Effect.runPromise(
      Effect.provide(
        detectSmartSupport(decodeFhirBaseUrl('https://ehr.example/fhir')),
        services.layer
      )
    )
    expect(services.requests.map((request) => Object.keys(request.headers))).toEqual([['accept']])
  })

  it('is `Open` on a non-ok HTTP answer (the server has no SMART config)', async () => {
    const support = await supportOf('https://open.example/fhir', answerStatus(404))
    expect(support).toEqual(SmartSupport.Open())
  })

  it('is `Open` when the config carries no authorization_endpoint', async () => {
    const support = await supportOf(
      'https://open.example/fhir',
      answerJson({ token_endpoint: 'https://open.example/token' })
    )
    expect(support).toEqual(SmartSupport.Open())
  })

  it('is `Open` when the ok response is not JSON', async () => {
    const support = await supportOf('https://open.example/fhir', answerText('<!doctype html>'))
    expect(support).toEqual(SmartSupport.Open())
  })

  it('is `Unreachable` (not `Open`) when the probe gets no response — a CORS/down server is not open access', async () => {
    const support = await supportOf('https://blocked.example/fhir', dropRequest)
    expect(support).toEqual(SmartSupport.Unreachable({ reason: 'Failed to fetch' }))
  })
})

describe('redirectToSignIn', () => {
  const config = {
    fhirBaseUrl: decodeFhirBaseUrl('https://ehr.example/fhir'),
    clientId: '9769f8b274370708d0d3ebb2e3e59b7c',
    scope: 'launch openid fhirUser',
    redirectUri: 'https://app.example/',
  }

  it('signs in at what the probe discovered, fetching its configuration once, when the probe is `Smart`', async () => {
    const services = servicesAnswering(answerJson(SMART_CONFIGURATION))
    const support = await Effect.runPromise(signIn(config, 'launch-1', services))
    expect(services.urls).toEqual(['https://ehr.example/fhir/.well-known/smart-configuration'])
    expect(support).toMatchObject({ _tag: 'Smart', discovered: discoveredAt(config.fhirBaseUrl) })
    expect(redirectToSignInAtMock).toHaveBeenCalledExactlyOnceWith(
      SmartSupport.$is('Smart')(support) ? support.discovered : undefined,
      config,
      'launch-1'
    )
    expect(redirectToSelfAddressedSignInReturnMock).not.toHaveBeenCalled()
  })

  it('signs in by a self-addressed redirect when the probe is `Open`, even for an EHR launch', async () => {
    const support = await Effect.runPromise(
      signIn(config, 'launch-1', servicesAnswering(answerStatus(404)))
    )
    expect(redirectToSelfAddressedSignInReturnMock).toHaveBeenCalledExactlyOnceWith({
      fhirBaseUrl: 'https://ehr.example/fhir',
      redirectUri: 'https://app.example/',
    })
    expect(redirectToSignInAtMock).not.toHaveBeenCalled()
    expect(support).toEqual(SmartSupport.Open())
  })

  it('does not redirect at all when the probe is `Unusable`, returning it for the UI', async () => {
    const support = await Effect.runPromise(
      signIn(
        config,
        undefined,
        servicesAnswering(
          answerJson({ ...SMART_CONFIGURATION, authorization_endpoint: 'javascript:alert(1)' })
        )
      )
    )
    expect(redirectToSignInAtMock).not.toHaveBeenCalled()
    expect(redirectToSelfAddressedSignInReturnMock).not.toHaveBeenCalled()
    expect(support).toMatchObject({ _tag: 'Unusable' })
  })

  it('fails with the sign-in’s own failure', async () => {
    // The probe saw a clean configuration; the sign-in could not retain its request.
    const blocked = new RetainedRequestUnusable({ reason: 'session storage is blocked' })
    redirectToSignInAtMock.mockReturnValue(Effect.fail(blocked))
    await expect(
      Effect.runPromise(
        Effect.flip(signIn(config, undefined, servicesAnswering(answerJson(SMART_CONFIGURATION))))
      )
    ).resolves.toBe(blocked)
  })

  it('does not redirect at all when the probe is `Unreachable`, returning it for the UI', async () => {
    const support = await Effect.runPromise(
      signIn(config, undefined, servicesAnswering(dropRequest))
    )
    expect(redirectToSignInAtMock).not.toHaveBeenCalled()
    expect(redirectToSelfAddressedSignInReturnMock).not.toHaveBeenCalled()
    expect(support).toEqual(SmartSupport.Unreachable({ reason: 'Failed to fetch' }))
  })
})

// `normalizeServerUrl`'s own behaviour is covered where it lives, in
// `authorization-core/smart-client`'s `server-target.test.ts`; re-exporting is
// only worth anything if it is genuinely the same function.
describe('normalizeServerUrl', () => {
  it('is the one implementation authorization-core owns, not a local copy', () => {
    expect(normalizeServerUrl).toBe(sharedNormalizeServerUrl)
  })
})

describe('insecureTargetReason', () => {
  it('is the one implementation authorization-core owns, not a local copy', () => {
    expect(insecureTargetReason).toBe(sharedInsecureTargetReason)
  })
})
