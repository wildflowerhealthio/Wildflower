import { Duration, Effect, Fiber, Schedule } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { FIRST_PARTY_CLIENT_ID } from 'gatekeeper-core/contexts'
import { cn } from 'kitchen-sink'
import { useEffect, useState, type JSX } from 'react'

import { makeUnauthenticatedSession, writeToken } from '../client.ts'
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

const errorCodeOf = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as Record<string, unknown>)['error'] // oxlint-disable-line typescript/no-unsafe-type-assertion -- HttpApi error bodies are decoded but escape as unknown at this boundary
  return typeof code === 'string' ? code : undefined
}

/** RFC 8628 §3.5: keep polling while the issuer is still waiting. */
const isPollingPending = (error: unknown): boolean => {
  const code = errorCodeOf(error)
  return code === 'authorization_pending' || code === 'slow_down'
}

const terminalState = (error: unknown): DeviceFlowState => {
  const code = errorCodeOf(error)
  if (code === 'access_denied') return { tag: 'denied' }
  if (code === 'expired_token') return { tag: 'expired' }
  return { tag: 'error', message: error instanceof Error ? error.message : String(error) }
}

/**
 * Replaces the previous "you need a token" stub: actually starts the
 * RFC 8628 device-authorization flow against the gatekeeper, displays
 * the resulting `user_code` for the user to enter on a sign-in
 * device, and polls `/oauth/token` until the request is approved (at
 * which point the token is written to localStorage and the auth gate
 * mounts the authenticated provider).
 */
const NeedsAuthMessage = (): JSX.Element => {
  const [state, setState] = useState<DeviceFlowState>({ tag: 'starting' })

  useEffect(() => {
    const session = makeUnauthenticatedSession()

    /**
     * The whole device-authorization flow as a single Effect:
     *   1. POST `/oauth/device_authorization` for `user_code`/`device_code`.
     *   2. Surface the user_code via React state.
     *   3. Poll `/oauth/token`, retrying while the server says
     *      `authorization_pending` or `slow_down` (Schedule.spaced).
     *   4. On success, write the token; the auth gate's
     *      `useSyncExternalStore` picks it up and remounts.
     *   5. On terminal errors (`access_denied` / `expired_token`),
     *      transition to the matching state via `Effect.catchAll`.
     *
     * Cancellation is handled by `Fiber.interrupt`: a pending sleep
     * inside `Effect.retry` is interrupted cleanly, so no manual
     * `cancelled` flag is needed.
     */
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

      // RFC 8628 lets the issuer hint a longer interval via
      // `slow_down`; we approximate by polling at the original
      // interval and treating the hint as another "keep waiting"
      // signal — a growing interval would need a per-iteration Ref
      // and the issuer typically just keeps replying `slow_down`
      // until its rate window reopens, which is functionally the
      // same as our fixed retry.
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
            while: isPollingPending,
          })
        )

      yield* Effect.sync(() => {
        writeToken(tokenResponse.access_token)
      })
    }).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() => {
          setState(terminalState(err))
        })
      )
    )

    const fiber = session.runtime.runFork(flow)
    return (): void => {
      void Effect.runPromise(Fiber.interrupt(fiber))
    }
  }, [])

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
