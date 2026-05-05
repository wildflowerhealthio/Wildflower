import { Context, Layer } from 'effect'

/**
 * Default UX shape for `/oauth/authorize` when the OAuth client did not
 * pass `?display=polling`.
 *
 * - `'interactive'` — redirect to `/access/oauth-consents/:id/ui` so the
 *   Owner consents on the same device. Fits a single-device deployment
 *   where the Owner is also the user driving the OAuth client.
 * - `'out-of-band-polling'` — redirect to `/oauth/authorize/:id/page`,
 *   which renders a polling page in the OAuth client's browser. The
 *   Owner decides on a separate device through `/access/...` and the
 *   polling page picks up the approval. Fits a deployment where the
 *   Owner and the OAuth client are on different devices.
 *
 * The OAuth client can override per-request with `?display=polling`
 * (see `http-api-implementation/oauth.ts`); this Tag only chooses what
 * happens when no override is supplied.
 *
 * Adapter slices pick a default by providing one of the layers below or
 * constructing their own `Layer.succeed`.
 */
type OAuthDisplayMode = 'interactive' | 'out-of-band-polling'

class OAuthDisplayDefault extends Context.Tag('OAuthDisplayDefault')<
  OAuthDisplayDefault,
  OAuthDisplayMode
>() {}

const OAuthDisplayDefaultInteractive: Layer.Layer<OAuthDisplayDefault> = Layer.succeed(
  OAuthDisplayDefault,
  'interactive'
)

const OAuthDisplayDefaultOutOfBandPolling: Layer.Layer<OAuthDisplayDefault> = Layer.succeed(
  OAuthDisplayDefault,
  'out-of-band-polling'
)

export { OAuthDisplayDefault, OAuthDisplayDefaultInteractive, OAuthDisplayDefaultOutOfBandPolling }
export type { OAuthDisplayMode }
