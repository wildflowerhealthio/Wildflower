import type { Layer } from 'effect'
import { type BareSender, type MessageHandler } from 'effect-messaging-core'
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
  it('returns a Layer providing the Apps host handler tag and requiring TunnelStore + BareSender', () => {
    expectTypeOf(AppsBridgeExpo.ReceiverLayer).returns.toEqualTypeOf<
      Layer.Layer<MessageHandler.TagId<'Apps', 'Host'>, never, TunnelStore | BareSender>
    >()
  })

  it('takes no arguments', () => {
    expectTypeOf(AppsBridgeExpo.ReceiverLayer).parameters.toEqualTypeOf<[]>()
  })
})
