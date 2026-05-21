import type { Layer } from 'effect'
import { type MessageHandler } from 'effect-messaging-core'
import { expectTypeOf } from 'expect-type'
import type { TunnelStore } from 'tunnel-core/livestore'
import { AppsBridgeExpo } from './index.ts'

// Type-only tests don't execute `ReceiverLayer`, but importing
// `./index.ts` pulls in `tunnel-core/livestore` → `@livestore/livestore`,
// whose ESM output trips Jest's CJS resolver. Stub the heavy livestore
// surface; the type tests use the real declarations regardless.
jest.mock('tunnel-core/livestore', () => ({}))
jest.mock('apps-core/bridge', () => ({
  __esModule: true,
  default: {
    Host: { ReceiverLayer: (): unknown => ({}) },
  },
}))

describe('AppsBridgeExpo.ReceiverLayer', () => {
  it('returns a Layer providing the Apps host handler tag and requiring only TunnelStore', () => {
    // `BareSender` is no longer a layer-build requirement — the bridge
    // transport's dispatch fiber provides it per-handler-invocation.
    expectTypeOf(AppsBridgeExpo.ReceiverLayer).returns.toEqualTypeOf<
      Layer.Layer<MessageHandler.TagId<'Apps', 'Host'>, never, TunnelStore>
    >()
  })

  it('takes no arguments', () => {
    expectTypeOf(AppsBridgeExpo.ReceiverLayer).parameters.toEqualTypeOf<[]>()
  })
})
