import type { Layer } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import { expectTypeOf } from 'expect-type'
import { GatekeeperBridgeExpo } from './index.ts'

describe('GatekeeperBridgeExpo.ReceiverLayer', () => {
  it('returns a Layer providing the Gatekeeper host handler tag', () => {
    expectTypeOf(GatekeeperBridgeExpo.ReceiverLayer).returns.toEqualTypeOf<
      Layer.Layer<MessageHandler.TagId<'Gatekeeper', 'Host'>>
    >()
  })

  it('takes no arguments', () => {
    expectTypeOf(GatekeeperBridgeExpo.ReceiverLayer).parameters.toEqualTypeOf<[]>()
  })
})
