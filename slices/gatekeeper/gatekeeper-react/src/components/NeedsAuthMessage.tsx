import { Duration, Effect, Either, Fiber, Match, Predicate, Schedule, Schema } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { FIRST_PARTY_CLIENT_ID } from 'gatekeeper-core/contexts'
import { OAuth } from 'gatekeeper-core/http-api-definition'

import { useEffect, useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Field, FieldDescription, pageLayoutStyles } from 'react-tundraish'

import { writeToken } from '../client/token-storage.ts'
import { useGatekeeperRuntimeLayer } from '../router-context.ts'
import deviceEntryStyles from '../routes/_open/gatekeeper/devices.module.css'
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
 * that happens during the host's `WaitForToken` → `AuthTokenIssued`
 * handshake (URL params dispatch + transport flush), so a stray render
 * doesn't kick off a real device-authorization flow. `TransportProvider`'s
 * `flushed` gate already blocks descendant mount until the host's URL-param
 * messages have dispatched, so under correct host behavior this sleep is
 * dead time. It exists as a defense against (a) a host that delays the
 * `AuthTokenIssued` follow-up after `WaitForToken`, and (b) other
 * mount-time races that would otherwise burn a device-code on the
 * gatekeeper server. There's no measured upper bound it's protecting
 * against — if a real bound surfaces, replace this with that bound or
 * drop the sleep entirely.
 */
const MOUNT_DEBOUNCE = Duration.millis(250)

/**
 * Starts the RFC 8628 device-authorization flow, surfaces the `user_code`,
 * and polls `/oauth/token` until approval. On success writes the token via
 * {@link writeToken}, which routes through the shared `authTokenRef` so the
 * auth gate's stream subscriber picks it up.
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

      const auth = yield* client.oauth.DeviceAuthorization({
        payload: { client_id: FIRST_PARTY_CLIENT_ID, scope: 'owner' },
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
        writeToken(tokenResponse.access_token)
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
  }, [layer])

  if (state.tag === 'starting') {
    return (
      <div className={pageLayoutStyles['page']}>
        <p className="text-body-2">Starting sign-in…</p>
      </div>
    )
  }
  if (state.tag === 'pending') {
    return (
      <div className={pageLayoutStyles['page']}>
        <h1 className="text-heading-4">Sign in on another device</h1>
        <p className="text-body-2">
          Open <code>{state.verificationUri}</code> on a signed-in device and enter the code below.
        </p>
        <Field label="Code">
          <pre className={deviceEntryStyles['pin-input']}>{state.userCode}</pre>
        </Field>
        <FieldDescription>
          Or open the direct link:{' '}
          <a href={state.verificationUriComplete}>{state.verificationUriComplete}</a>
        </FieldDescription>
        <FieldDescription>
          Waiting for approval — this page will reload automatically once you sign in.
        </FieldDescription>
      </div>
    )
  }
  if (state.tag === 'denied') {
    return (
      <div className={pageLayoutStyles['page']}>
        <h1 className={cn(pageLayout['poll-declined'], 'text-heading-4')}>Sign-in denied</h1>
        <p className="text-body-2">The sign-in request was denied. Refresh to try again.</p>
      </div>
    )
  }
  if (state.tag === 'expired') {
    return (
      <div className={pageLayoutStyles['page']}>
        <h1 className={cn(pageLayout['poll-declined'], 'text-heading-4')}>Sign-in expired</h1>
        <p className="text-body-2">
          The code expired before sign-in completed. Refresh to try again.
        </p>
      </div>
    )
  }
  return (
    <div className={pageLayoutStyles['page']}>
      <h1 className={cn(pageLayout['poll-declined'], 'text-heading-4')}>Sign-in failed</h1>
      <p className={cn(pageLayoutStyles['error'], 'text-body-3')}>{state.message}</p>
    </div>
  )
}

export { NeedsAuthMessage }
export type { DeviceFlowState }
