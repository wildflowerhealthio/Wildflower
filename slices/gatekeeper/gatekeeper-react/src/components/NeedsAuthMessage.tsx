/* oxlint-disable react/only-export-components ---
  Neither export changes often and sanitizeReturnTo is only used in tests */
import { Duration, Effect, Either, Fiber, Match, Predicate, Schedule, Schema } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { FIRST_PARTY_CLIENT_ID } from 'gatekeeper-core/contexts'
import { OAuth } from 'gatekeeper-core/http-api-definition'

import { Fragment, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { AuthedUntil, cn, useAuthStateSetter } from 'react-kitchen-sink'
import { Field, FieldDescription, pageLayoutStyles, TextField } from 'react-tundraish'
import { GrantDraft, ScopeRequest } from 'scopes-core'
import type { GrantDraft as GrantDraftModel } from 'scopes-core'
import { ScopePicker } from 'scopes-react'

import { parseDeviceLoginSearch, parseRequestScopes } from '../device-login-route.ts'
import {
  useGatekeeperFirstPartyClientId,
  useGatekeeperLocalGrantedScopes,
  useGatekeeperRuntimeLayer,
} from '../router-context.ts'
import deviceCodeStyles from '../styles/device-code.module.css'
import pageLayout from '../styles/page-layout.module.css'

type DeviceFlowState =
  | { readonly tag: 'form' }
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

/** The first-party client's allowed scopes when the host context carries none (standalone/web). */
const DEFAULT_ALLOWED_SCOPES = 'system/*.cruds wildflower/*.cruds'

/**
 * The happy-path request the setup form starts from: read + search on every record
 * across all patients, plus the Wildflower admin surface — the most common device
 * grant, pre-filled so the default flow is name-it-and-go rather than rule-by-rule
 * assembly. Only seeded when the client's allowed set actually covers it.
 */
const PRESET_REQUEST_SCOPES = ['system/*.rs', 'wildflower/*.rs']

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

/**
 * Split a pre-filled step-up request into the scopes this client may actually
 * ask for and the ones it may not.
 *
 * `/oauth/device_authorization` rejects the **whole** request with
 * `invalid_scope` when any requested scope falls outside the client's
 * `allowed_scopes` — so an out-of-envelope scope can't just ride along, or
 * pressing "Request access" would dead-end on an OAuth error instead of
 * starting the flow. `ungrantable` is therefore kept out of the draft but
 * surfaced in the form: the user is told which permission this client can't
 * request rather than watching it silently vanish from the picker.
 *
 * Membership is decided with the picker's own clamp
 * ({@link ScopeRequest.isWithin}), which is coverage-aware the same way the
 * server's `allowed_scope_covers` is — so anything this admits is a scope the
 * device-authorization check also admits.
 */
const partitionByGrantability = (
  scopes: readonly string[],
  request: ScopeRequest.ScopeRequest
): { readonly grantable: readonly string[]; readonly ungrantable: readonly string[] } => {
  const grantable: string[] = []
  const ungrantable: string[] = []
  for (const scope of scopes) {
    if (ScopeRequest.isWithin(GrantDraft.fromScopes([scope], null), request)) grantable.push(scope)
    else ungrantable.push(scope)
  }
  return { grantable, ungrantable }
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
 * The device-login screen. On landing it shows a setup **form** — a device-name
 * field and the shared {@link ScopePicker} in `expandable` mode, seeded with the
 * {@link PRESET_REQUEST_SCOPES} happy path when the client's allowed set covers
 * it — so the user names the device and adjusts what to request before anything
 * hits the network. Only on "Start sign-in" does it run the RFC 8628
 * device-authorization flow: surface the `user_code`, poll `/oauth/token` until
 * approval, then write the token via the `AuthStateStore` provided by the
 * surrounding `<AuthStateProvider>` (resolved through {@link useAuthStateSetter})
 * and navigate to the sanitized `?returnTo=` path (or {@link POST_AUTH_DEFAULT_PATH})
 * with a full page load so the app reboots with the bearer in place.
 *
 * It doubles as the **step-up** target (resource-authorization epic child ⑤):
 * when a `403 InsufficientScope` surface sends the user here via
 * `buildStepUpTarget`, the `?requestScopes=` param pre-fills the picker with the
 * scopes that were missing — unioned with {@link PRESET_REQUEST_SCOPES}, since
 * the device flow mints a whole new grant and requesting *only* the missing
 * scopes would strip what the session could already do. Because that same
 * navigation sets `returnTo` to where the denial happened, the full page load on
 * grant lands back on the original page and its loader re-runs the denied action
 * against the new grant. Scopes outside the client's `allowed_scopes` are named
 * rather than requested — see {@link partitionByGrantability}.
 *
 * @remarks
 * Because the flow is now user-gated (a button click), nothing fires on mount —
 * so the old mount-time debounce that guarded against a transient render burning
 * a device code is gone. The forked flow still interrupts on unmount so a
 * navigation mid-poll leaves no orphan device code on the gatekeeper server.
 */
const NeedsAuthMessage = (): JSX.Element => {
  const [state, setState] = useState<DeviceFlowState>({ tag: 'form' })
  const [deviceName, setDeviceName] = useState('')
  const setAuthState = useAuthStateSetter()
  // Long-running device flow with retry — needs a fiber handle for
  // interrupt-on-unmount, which the promise-returning `runAuthed` can't
  // give. Runs against the composed `runtimeLayer` from router context
  // (`HttpClient | GatekeeperHttpApiClient`), provided once by the app —
  // not a one-shot query.
  const layer = useGatekeeperRuntimeLayer()
  // The first-party client's full `allowed_scopes` set, threaded from the Tauri
  // shell's `tauri-shared-config.json` (the single source gatekeeper also reads
  // to seed those `allowed_scopes`), so the two can't drift. It is the picker's
  // *expansion envelope* here: the user can request anything within it, so the
  // built request always passes the device_authorization coverage check. The
  // literal fallback covers standalone/web renders where the host carries none.
  const localGrantedScopes = useGatekeeperLocalGrantedScopes()
  // The host's first-party `client_id`, threaded from `tauri-shared-config.json`
  // on Tauri; `FIRST_PARTY_CLIENT_ID` is the standalone/web fallback (the two
  // can't drift — the config is the shared source). Used as the device-login
  // request's `client_id` below.
  const firstPartyClientId = useGatekeeperFirstPartyClientId() ?? FIRST_PARTY_CLIENT_ID

  // The step-up pre-fill: the scopes a `403 InsufficientScope` named, threaded
  // here as `?requestScopes=` by `buildStepUpTarget`. Read once at mount (the
  // param can't change without a remount), and empty on the plain sign-in path.
  const requestedScopes = useMemo(
    () => parseRequestScopes(parseDeviceLoginSearch(window.location.search).requestScopes),
    []
  )
  const available = useMemo(
    () => (localGrantedScopes ?? DEFAULT_ALLOWED_SCOPES).split(/\s+/).filter(Boolean),
    [localGrantedScopes]
  )
  // Which of the pre-filled scopes this client may ask for at all — see
  // {@link partitionByGrantability} for why the rest is named instead of requested.
  const { grantable, ungrantable } = useMemo(
    () =>
      partitionByGrantability(
        requestedScopes,
        ScopeRequest.expandable({ requested: [], available })
      ),
    [requestedScopes, available]
  )

  // The expandable picker request: seeded with whatever the step-up pre-filled
  // (nothing on the plain sign-in path — the user builds it), grantable up to
  // the client's allowed set.
  const request = useMemo(
    () => ScopeRequest.expandable({ requested: grantable, available }),
    [grantable, available]
  )
  const [draft, setDraft] = useState<GrantDraftModel.GrantDraft>(() => {
    // Seed the read+search happy path when the envelope covers it, *unioned* with
    // the step-up scopes: the device flow mints a whole new grant, so requesting
    // only the missing scopes would strip the access the session already had.
    // Otherwise fall back to the empty draft (the user builds the request within
    // what's allowed).
    const preset = GrantDraft.fromScopes(PRESET_REQUEST_SCOPES, null)
    const presetScopes = ScopeRequest.isWithin(preset, request) ? PRESET_REQUEST_SCOPES : []
    const seeded = GrantDraft.fromScopes([...grantable, ...presetScopes], null)
    return ScopeRequest.isWithin(seeded, request) ? seeded : GrantDraft.initial(request)
  })

  // The forked flow, so an unmount mid-poll interrupts it (no orphan device code).
  const fiberRef = useRef<Fiber.RuntimeFiber<void, never> | null>(null)
  useEffect(
    () => () => {
      if (fiberRef.current !== null) void Effect.runPromise(Fiber.interrupt(fiberRef.current))
    },
    []
  )

  const handleStart = (): void => {
    const scopes = GrantDraft.serializeAll(draft).join(' ')
    const trimmedName = deviceName.trim()
    setState({ tag: 'starting' })
    const flow = Effect.gen(function* () {
      const client = yield* GatekeeperHttpApiClient

      const auth = yield* client.oauth.DeviceAuthorization({
        payload: {
          client_id: firstPartyClientId,
          // Omit an empty scope entirely — the owner then grants from scratch (device consent
          // is expandable), rather than the server parsing a blank scope string.
          ...(scopes === '' ? {} : { scope: scopes }),
          ...(trimmedName === '' ? {} : { device_name: trimmedName }),
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
            client_id: firstPartyClientId,
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
        // Nudge the store to publish the freshly-authed signal. The web store
        // ignores the argument and re-derives from the `wf_auth_exp` cookie the
        // server just set (its source of truth); `AuthedUntil` is the honest
        // value this sign-in just achieved. The full-page reload below rebuilds
        // the store from the cookie anyway.
        setAuthState(AuthedUntil({ exp: Math.floor(Date.now() / 1000) + tokenResponse.expires_in }))
        // Full-page navigation (not a client-side route push) so the app
        // re-boots with the now-persisted bearer in place — matching the
        // "this page will reload automatically once you sign in" copy.
        const returnTo = sanitizeReturnTo(
          parseDeviceLoginSearch(window.location.search).returnTo ?? null
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

    fiberRef.current = Effect.runFork(flow)
  }

  if (state.tag === 'form') {
    return (
      <>
        <h1 className="text-heading-6">Set up temporary device access</h1>
        <p className="text-body-2">
          Name this device and choose what it should be able to access. A signed-in device will
          review and approve the request.
        </p>
        {grantable.length > 0 ? (
          <p className="text-body-3">
            The permissions the action you tried needs are already selected below.
          </p>
        ) : null}
        {ungrantable.length > 0 ? (
          <p className={cn(pageLayoutStyles['error'], 'text-body-3')}>
            This application isn’t allowed to request{' '}
            {ungrantable.map((scope, i) => (
              <Fragment key={scope}>
                <code>{scope}</code>
                {i === ungrantable.length - 1 ? '' : ', '}
              </Fragment>
            ))}
            , so it can’t be included. An administrator has to widen the client’s allowed scopes
            first.
          </p>
        ) : null}
        <TextField
          label="Device name"
          value={deviceName}
          onChange={setDeviceName}
          placeholder="e.g. Ada's laptop"
          autoCapitalize="words"
        />
        <ScopePicker
          subjectName={deviceName.trim() === '' ? 'This device' : deviceName.trim()}
          request={request}
          draft={draft}
          onDraftChange={setDraft}
          mode="expandable"
          phrasing="requesting"
          // The FHIR server's patient/ support is too weak to rely on, so a device request
          // targets all patients only — pin the subject and hide the subject selector.
          forcedSubject="system"
        />
        <div className={pageLayout['buttons']}>
          <button type="button" className="button-2 filled" onClick={handleStart}>
            Request access
          </button>
        </div>
      </>
    )
  }
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
