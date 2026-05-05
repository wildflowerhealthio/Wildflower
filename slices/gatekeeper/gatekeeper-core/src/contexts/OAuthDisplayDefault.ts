import { Context, Layer } from 'effect'

type OAuthDisplayMode = 'interactive' | 'polling'

class OAuthDisplayDefault extends Context.Tag('OAuthDisplayDefault')<
  OAuthDisplayDefault,
  OAuthDisplayMode
>() {}

const OAuthDisplayDefaultInteractive: Layer.Layer<OAuthDisplayDefault> = Layer.succeed(
  OAuthDisplayDefault,
  'interactive'
)

const OAuthDisplayDefaultPolling: Layer.Layer<OAuthDisplayDefault> = Layer.succeed(
  OAuthDisplayDefault,
  'polling'
)

export { OAuthDisplayDefault, OAuthDisplayDefaultInteractive, OAuthDisplayDefaultPolling }
export type { OAuthDisplayMode }
