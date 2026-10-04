import { Array, DateTime, Match, Option } from 'effect'

import type { CallerSummary, LoggedRequest, RequestAuth } from './queries.ts'

/** What a row shows for a request no bearer gate verified. */
const UNAUTHENTICATED = 'Unauthenticated'

/**
 * Who made a logged request, as the owner reads it: the client's display name
 * from `names` (gatekeeper's client list), else its `clientId`, else
 * {@link UNAUTHENTICATED} when no caller was verified.
 */
const callerNameOf = (clientId: string | null, names: ReadonlyMap<string, string>): string =>
  clientId === null ? UNAUTHENTICATED : (names.get(clientId) ?? clientId)

type RequestRefusal = NonNullable<LoggedRequest['refusal']>

/**
 * Why a request was refused — the bearer gate's recorded reason, else
 * `not authorized` on a `401` or `forbidden` on a `403` — or none when it
 * wasn't. A `401` or `403` is what the server's `refused` filter and
 * `refusedCount` count as refused.
 */
const refusalReasonOf = (status: number, refusal: RequestRefusal | null): Option.Option<string> =>
  Option.fromNullable(refusal).pipe(
    Option.map(
      Match.type<RequestRefusal>().pipe(
        Match.when('missingToken', () => 'no token'),
        Match.when('tokenRejected', () => 'token rejected'),
        Match.when('revoked', () => 'token revoked'),
        Match.exhaustive
      )
    ),
    Option.orElse(() =>
      Match.value(status).pipe(
        Match.when(401, () => Option.some('not authorized')),
        Match.when(403, () => Option.some('forbidden')),
        Match.orElse(() => Option.none())
      )
    )
  )

/**
 * How a request met the bearer gates, by the server's `auth` filter's cases:
 *
 * - `authorized` — it needed sign-in and carried a valid token from `clientId`.
 * - `public` — it needed no sign-in, so no caller was verified.
 * - `refused` — a gate refused it (a `401`, with the gate's `reason`) or the
 *   caller lacked the scope (a `403`); `clientId` is set when a token was
 *   verified before the refusal.
 */
type RequestAccess =
  | { readonly auth: 'authorized'; readonly clientId: string }
  | { readonly auth: 'public' }
  | { readonly auth: 'refused'; readonly clientId: string | null; readonly reason: string }

/** What {@link requestAccessOf} reads off a logged request or a caller's last one. */
interface RequestOutcome {
  readonly clientId: string | null
  readonly status: number
  readonly refusal: RequestRefusal | null
}

/** Classify a request into its {@link RequestAccess}. */
const requestAccessOf = ({ clientId, status, refusal }: RequestOutcome): RequestAccess =>
  refusalReasonOf(status, refusal).pipe(
    Option.map((reason): RequestAccess => ({ auth: 'refused', clientId, reason })),
    Option.getOrElse((): RequestAccess =>
      clientId === null ? { auth: 'public' } : { auth: 'authorized', clientId }
    )
  )

/** The owner-facing name of each `auth` case — the filter's options and the rows' label. */
const AUTH_LABELS: Readonly<Record<RequestAuth, string>> = {
  authorized: 'Signed in',
  public: 'No sign-in needed',
  refused: 'Refused',
}

/** The owner-facing line for a {@link RequestAccess}: its label, and why when refused. */
const accessLabelOf = (access: RequestAccess): string =>
  access.auth === 'refused' ? `${AUTH_LABELS.refused} · ${access.reason}` : AUTH_LABELS[access.auth]

/** What the log holds for one client, across every address it called from. */
interface ClientActivity {
  readonly requestCount: number
  readonly refusedCount: number
  readonly addressCount: number
  readonly firstSeen: DateTime.Utc
  readonly lastSeen: DateTime.Utc
}

/**
 * Fold a client's `ListCallers` rows (one per address) into one
 * {@link ClientActivity}, or none when the log holds nothing from it.
 */
const clientActivityOf = (
  callers: readonly CallerSummary[],
  clientId: string
): Option.Option<ClientActivity> =>
  Option.map(
    Array.match(
      callers.filter((caller) => caller.clientId === clientId),
      { onEmpty: Option.none, onNonEmpty: Option.some }
    ),
    (rows) => ({
      requestCount: rows.reduce((sum, row) => sum + row.requestCount, 0),
      refusedCount: rows.reduce((sum, row) => sum + row.refusedCount, 0),
      addressCount: new Set(rows.map((row) => row.address)).size,
      firstSeen: rows.map((row) => row.firstSeen).reduce((a, b) => DateTime.min(a, b)),
      lastSeen: rows.map((row) => row.lastSeen).reduce((a, b) => DateTime.max(a, b)),
    })
  )

export {
  accessLabelOf,
  AUTH_LABELS,
  callerNameOf,
  clientActivityOf,
  requestAccessOf,
  UNAUTHENTICATED,
}
export type { ClientActivity, RequestAccess, RequestOutcome }
