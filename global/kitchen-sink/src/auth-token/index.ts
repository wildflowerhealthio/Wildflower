import { Context, type Subscribable } from 'effect'

/**
 * Effect service carrying the live `Subscribable<string | null>` for the
 * current bearer token. Consumers (e.g. an `HttpApiClient`'s
 * `transformClient`) read the value at request time via
 * `Subscribable.get`, so a rotation surfaces on the next request
 * without rebuilding the layer or runtime.
 *
 * The package that owns auth constructs the Subscribable — usually a
 * module-scoped `SubscriptionRef` that bidirectionally syncs with
 * localStorage on the web, or with a secure store on native — and
 * wires it via `Layer.succeed(BearerToken, subscribable)`.
 */
class BearerToken extends Context.Tag('BearerToken')<
  BearerToken,
  Subscribable.Subscribable<string | null>
>() {}

export { BearerToken }
