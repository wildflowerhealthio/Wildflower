/* oxlint-disable react/only-export-components ---
  Neither export changes often and sanitizeReturnTo is only used in tests */
import { Duration, Effect, Either, Fiber, Match, Predicate, Schedule, Schema } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { FIRST_PARTY_CLIENT_ID } from 'gatekeeper-core/contexts'
import { OAuth } from 'gatekeeper-core/http-api-definition'

import { useEffect, useState, type JSX } from 'react'
import { cn, useAuthTokenSetter } from 'react-kitchen-sink'
import { Field, FieldDescription, pageLayoutStyles } from 'react-tundraish'

import { useGatekeeperRuntimeLayer } from '../router-context.ts'
import deviceCodeStyles from '../styles/device-code.module.css'
import pageLayout from '../styles/page-layout.module.css'

type DeviceFlowState =
  | { readonly tag: 'starting' }
  | {
      readonly tag: 'pending'
      readonly userCode: string
      readonly verificationUri: string
      readonly verificationUriComplete: string
    }
  | { readonly tag: 'denied' }
  | { readonly tag: 'expired' }
  | { readonly tag: 'error'; readonly message: string }

const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

/** Where sign-in lands when no usable `returnTo` was supplied. */
const POST_AUTH_DEFAULT_PATH = '/home'

/**
 * Resolve the post-sign-in destination from a caller-supplied
 * `?returnTo=` value, falling back to {@link POST_AUTH_DEFAULT_PATH}.
 *
 * The value is attacker-controllable (it rides a query parameter), so
 * only a **same-origin absolute path** is accepted: it must start with a
 * single `/`. Protocol-relative (`//evil.com`) and backslash-smuggled
 * (`/\evil.com`) forms — which a browser resolves to a *different
 * origin* — are rejected, closing the open-redirect hole. Anything else
 * (a full URL, a `javascript:` payload, an empty/missing value) also
 * falls back to the default.
 */
const sanitizeReturnTo = (raw: string | null): string => {
  if (raw === null || raw === '') return POST_AUTH_DEFAULT_PATH
  if (!raw.startsWith('/')) return POST_AUTH_DEFAULT_PATH
  if (raw.startsWith('//') || raw.startsWith('/\\')) return POST_AUTH_DEFAULT_PATH
  return raw
}

// Decoding gives literal `error` codes so downstream `Match.when({error: '…'})` is exhaustive.
const OAuthErrorSchema = Schema.Union(OAuth.OAuthError400Schema, OAuth.OAuthError401Schema)
type OAuthErrorBody = Schema.Schema.Type<typeof OAuthErrorSchema>
const decodeOAuthError = Schema.decodeUnknownEither(OAuthErrorSchema)

const formatOAuthError = (body: OAuthErrorBody): string =>
  body.error_description !== undefined ? `${body.error}: ${body.error_description}` : body.error

// Network failures, unexpected shapes, thrown strings — typed OAuth errors decode on the OAuth branch.
const formatGenericError = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** RFC 8628 §3.5: keep polling while the issuer is still waiting. */
const isRetryable = Predicate.compose(
  Schema.is(OAuthErrorSchema),
  ({ error }) => error === 'authorization_pending' || error === 'slow_down'
)

/** Map a thrown value to the next `DeviceFlowState`. */
const toErrorState = (error: unknown): DeviceFlowState =>
  Either.match(decodeOAuthError(error), {
    onLeft: () => ({ tag: 'error', message: formatGenericError(error) }),
    onRight: Match.type<OAuthErrorBody>().pipe(
      Match.withReturnType<DeviceFlowState>(),
      Match.when({ error: 'access_denied' }, () => ({ tag: 'denied' })),
      Match.when({ error: 'expired_token' }, () => ({ tag: 'expired' })),
      Match.orElse((body) => ({ tag: 'error', message: formatOAuthError(body) }))
    ),
  })

/**
 * Grace period before any real OAuth I/O fires — see {@link NeedsAuthMessage}.
 *
 * @remarks
 * The 250ms value is a guess: it's intended to absorb a transient mount
 * that happens during the host's `AuthTokenIssued` handshake (post-mount
 * token delivery over the gatekeeper bridge), so a stray render doesn't
 * kick off a real device-authorization flow. The `_auth` `beforeLoad`
 * gate's `awaitEmbeddedAuthReady` already waits the bridge handshake +
 * token before any authed subtree renders, so under correct host
 * behavior this sleep is dead time. It exists as a defense against
 * (a) a host that delays the `AuthTokenIssued` send relative to the
 * transport's `signalReady`, and (b) other mount-time races that would
 * otherwise burn a device-code on the gatekeeper server. There's no
 * measured upper bound it's protecting against — if a real bound
 * surfaces, replace this with that bound or drop the sleep entirely.
 */
const MOUNT_DEBOUNCE = Duration.millis(250)

/**
 * Starts the RFC 8628 device-authorization flow, surfaces the `user_code`,
 * and polls `/oauth/token` until approval. On success writes the token via
 * the `AuthTokenStore` provided by the surrounding `<AuthTokenProvider>`
 * (resolved through {@link useAuthTokenSetter}), so the same write path
 * the page-bridge `AuthTokenIssued` handler takes also flows through here,
 * then navigates to the sanitized `?returnTo=` path (or
 * {@link POST_AUTH_DEFAULT_PATH}) with a full page load so the app reboots
 * with the bearer in place.
 *
 * @remarks
 * The boot side effects are gated by a {@link MOUNT_DEBOUNCE} sleep so
 * a transient mount during a token-race (e.g. an `AuthTokenIssued` is
 * about to arrive over the gatekeeper bridge) does not start a real
 * device authorization. Unmount within the window interrupts the fiber
 * before any network I/O — no orphan device-code is left on the
 * gatekeeper server.
 */
const NeedsAuthMessage = (): JSX.Element => {
  const [state, setState] = useState<DeviceFlowState>({ tag: 'starting' })
  const setToken = useAuthTokenSetter()
  // Long-running device flow with retry — needs a fiber handle for
  // interrupt-on-unmount, which the promise-returning `runAuthed` can't
  // give. Runs against the composed `runtimeLayer` from router context
  // (`BearerToken | HttpClient | GatekeeperHttpApiClient`), provided once
  // by the app — not a one-shot query.
  const layer = useGatekeeperRuntimeLayer()

  useEffect(() => {
    const flow = Effect.gen(function* () {
      yield* Effect.sleep(MOUNT_DEBOUNCE)
      const client = yield* GatekeeperHttpApiClient

      // Request the first-party client's full `allowed_scopes` set
      // (gatekeeper-rust's `WILDFLOWER_LOCAL_GRANTED_SCOPES`):
      // `system/*.cruds` is the full-FHIR wildcard HFS reads to authorize
      // the WebView's FHIR calls, and `wildflower/*.cruds` is the
      // full-Wildflower-resource grant that gates gatekeeper's `/access/*`
      // admin surface. The device_authorization handler validates each
      // requested scope by exact string against the first-party client's
      // `allowed_scopes` and rejects the whole request with `invalid_scope`
      // on any miss, so this set must match those scopes exactly.
      const auth = yield* client.oauth.DeviceAuthorization({
        payload: {
          client_id: FIRST_PARTY_CLIENT_ID,
          scope: 'system/*.cruds wildflower/*.cruds',
        },
      })

      yield* Effect.sync(() => {
        setState({
          tag: 'pending',
          userCode: auth.user_code,
          verificationUri: auth.verification_uri,
          verificationUriComplete: auth.verification_uri_complete,
        })
      })

      // RFC 8628 `slow_down` is treated as another "keep waiting" signal — a fixed retry approximates a growing interval.
      const tokenResponse = yield* client.oauth
        .TokenExchange({
          payload: {
            grant_type: DEVICE_GRANT_TYPE,
            client_id: FIRST_PARTY_CLIENT_ID,
            device_code: auth.device_code,
          },
        })
        .pipe(
          Effect.retry({
            schedule: Schedule.spaced(Duration.seconds(Math.max(auth.interval, 1))),
            while: isRetryable,
          })
        )

      yield* Effect.sync(() => {
        setToken(tokenResponse.access_token)
        // Full-page navigation (not a client-side route push) so the app
        // re-boots with the now-persisted bearer in place — matching the
        // "this page will reload automatically once you sign in" copy.
        const returnTo = sanitizeReturnTo(
          new URLSearchParams(window.location.search).get('returnTo')
        )
        window.location.assign(returnTo)
      })
    }).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() => {
          setState(toErrorState(err))
        })
      ),
      Effect.provide(layer)
    )

    const fiber = Effect.runFork(flow)
    return (): void => {
      void Effect.runPromise(Fiber.interrupt(fiber))
    }
    // `setToken`'s identity is stable for the surrounding
    // `AuthTokenStore`'s lifetime (returned from `useAuthTokenSetter`
    // and constructed once per `main-*` entry); including it in the
    // dep array makes the dependency explicit without churning.
  }, [layer, setToken])

  if (state.tag === 'starting') {
    return <p className="text-body-2">Starting sign-in…</p>
  }
  if (state.tag === 'pending') {
    return (
      <>
        <h1 className="text-heading-6">Sign in on another device</h1>
        <p className="text-body-2">
          Open <code>{state.verificationUri}</code> on a signed-in device and enter the code below.
        </p>
        <Field label="Code">
          <pre className={deviceCodeStyles['pin-input']}>{state.userCode}</pre>
        </Field>
        <FieldDescription>
          Or open the direct link:{' '}
          <a href={state.verificationUriComplete}>{state.verificationUriComplete}</a>
        </FieldDescription>
        <FieldDescription>
          Waiting for approval — this page will reload automatically once you sign in.
        </FieldDescription>
      </>
    )
  }
  if (state.tag === 'denied') {
    return (
      <>
        <h1 className={cn(pageLayout['poll-declined'], 'text-heading-6')}>Sign-in denied</h1>
        <p className="text-body-2">The sign-in request was denied. Refresh to try again.</p>
      </>
    )
  }
  if (state.tag === 'expired') {
    return (
      <>
        <h1 className={cn(pageLayout['poll-declined'], 'text-heading-6')}>Sign-in expired</h1>
        <p className="text-body-2">
          The code expired before sign-in completed. Refresh to try again.
        </p>
      </>
    )
  }
  return (
    <>
      <h1 className={cn(pageLayout['poll-declined'], 'text-heading-6')}>Sign-in failed</h1>
      <p className={cn(pageLayoutStyles['error'], 'text-body-3')}>{state.message}</p>
    </>
  )
}

export { NeedsAuthMessage, sanitizeReturnTo }
export type { DeviceFlowState }
