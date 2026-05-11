import { Duration, Effect, Either, Fiber, Match, Predicate, Schedule, Schema } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { FIRST_PARTY_CLIENT_ID } from 'gatekeeper-core/contexts'
import { OAuth } from 'gatekeeper-core/http-api-definition'

import { useEffect, useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'

import { writeToken } from '../client/token-storage.ts'
import { useGatekeeperClient } from '../use-gatekeeper-client.ts'
import { Field, FieldDescription } from './Field.tsx'
import deviceEntryStyles from '../screens/device-entry.module.css'
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
 * Starts the RFC 8628 device-authorization flow, surfaces the `user_code`,
 * and polls `/oauth/token` until approval. On success writes the token to
 * `localStorage`, where the auth gate's `useSyncExternalStore` picks it up.
 */
const NeedsAuthMessage = (): JSX.Element => {
  const [state, setState] = useState<DeviceFlowState>({ tag: 'starting' })
  const gatekeeperClient = useGatekeeperClient()

  useEffect(() => {
    const flow = Effect.gen(function* () {
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
      )
    )

    const fiber = gatekeeperClient.runtime.runFork(flow)
    return (): void => {
      void Effect.runPromise(Fiber.interrupt(fiber))
    }
  }, [gatekeeperClient])

  if (state.tag === 'starting') {
    return (
      <div className={pageLayout['page']}>
        <p className="text-body-2">Starting sign-in…</p>
      </div>
    )
  }
  if (state.tag === 'pending') {
    return (
      <div className={pageLayout['page']}>
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
      <div className={pageLayout['page']}>
        <h1 className={cn(pageLayout['poll-declined'], 'text-heading-4')}>Sign-in denied</h1>
        <p className="text-body-2">The sign-in request was denied. Refresh to try again.</p>
      </div>
    )
  }
  if (state.tag === 'expired') {
    return (
      <div className={pageLayout['page']}>
        <h1 className={cn(pageLayout['poll-declined'], 'text-heading-4')}>Sign-in expired</h1>
        <p className="text-body-2">
          The code expired before sign-in completed. Refresh to try again.
        </p>
      </div>
    )
  }
  return (
    <div className={pageLayout['page']}>
      <h1 className={cn(pageLayout['poll-declined'], 'text-heading-4')}>Sign-in failed</h1>
      <p className={cn(pageLayout['error'], 'text-body-3')}>{state.message}</p>
    </div>
  )
}

export { NeedsAuthMessage }
export type { DeviceFlowState }
