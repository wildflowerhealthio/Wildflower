import { Context, Layer } from 'effect'

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
