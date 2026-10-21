/**
 * How long a client's refresh-token families last once it has signed in: the
 * `refreshPolicy` of a `clients` row. The server reads it on every refresh, so
 * a change applies to the client's families on their next refresh, and
 * revoking a browser session ends the families minted under it whatever the
 * policy says.
 *
 * Namespace module (`import { RefreshPolicy } from '@wildflowerhealthio/authorization-core/domain'`):
 * `RefreshPolicy.Schema` / `RefreshPolicy.Type`, with `RefreshPolicy.ceiling`.
 */

import { Duration, Schema } from 'effect'

/**
 * The longest any refresh-token family lasts, from when it was issued,
 * whatever its client's policy says: the server's
 * `REFRESH_TOKEN_FAMILY_CEILING`. No limit may be longer.
 */
const ceiling: Duration.Duration = Duration.days(365)

/**
 * A limit as the wire carries it, in whole seconds: at least one, and no
 * longer than {@link ceiling}.
 */
const LimitFromSeconds = Schema.transform(
  Schema.Int.pipe(Schema.between(1, Duration.toSeconds(ceiling))),
  Schema.DurationFromSelf,
  {
    strict: true,
    decode: (seconds) => Duration.seconds(seconds),
    encode: (limit) => Duration.toSeconds(limit),
  }
)

/**
 * One client's refresh policy.
 *
 * - `idleTtl`: a family ends if nothing refreshes it for this long, from its
 *   last rotation; `None` for no idle limit.
 * - `maxTtl`: a family ends this long after it was issued; `None` for only the
 *   {@link ceiling}.
 * - `endsWithBrowserSession`: a family ends when the browser session it was
 *   minted under expires. A family minted under no session (a paired device)
 *   has none to end with.
 */
const RefreshPolicySchema = Schema.Struct({
  idleTtl: Schema.propertySignature(Schema.OptionFromNullOr(LimitFromSeconds)).pipe(
    Schema.fromKey('idleTtlSeconds')
  ),
  maxTtl: Schema.propertySignature(Schema.OptionFromNullOr(LimitFromSeconds)).pipe(
    Schema.fromKey('maxTtlSeconds')
  ),
  endsWithBrowserSession: Schema.Boolean,
})

type RefreshPolicyType = typeof RefreshPolicySchema.Type

export { ceiling, RefreshPolicySchema as Schema, type RefreshPolicyType as Type }
