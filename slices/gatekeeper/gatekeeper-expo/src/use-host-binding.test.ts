import { renderHook } from '@testing-library/react-native'
import { Context, Effect, Layer, type Layer as LayerNs } from 'effect'
import type { HostBinding, MessageHandler } from 'effect-messaging-core'
import { expectTypeOf } from 'expect-type'
import type { GatekeeperBridge } from 'gatekeeper-core/bridge'
import { GatekeeperBridgeExpo } from './index.ts'
import { useGatekeeperHostBinding } from './use-host-binding.ts'

// Module-scope type assertions: `expectTypeOf` is a no-op at runtime, so
// wrapping it in `it()` would give the illusion of runtime coverage. Lifting
// to file scope means the type check fires at load and Jest doesn't count
// these as passing tests when only the implementation regresses.
expectTypeOf(GatekeeperBridgeExpo.useHostBinding).toEqualTypeOf(useGatekeeperHostBinding)
expectTypeOf<ReturnType<typeof useGatekeeperHostBinding>>().toEqualTypeOf<
  HostBinding.HostBinding<typeof GatekeeperBridge>
>()
expectTypeOf(useGatekeeperHostBinding).parameters.toEqualTypeOf<
  [({ readonly token?: string } | undefined)?]
>()

describe('useGatekeeperHostBinding receiverLayer', () => {
  it('builds at runtime and provides the Gatekeeper Host handler tag with no message handlers (Gatekeeper has no web→host messages)', async () => {
    const { result } = renderHook(() => useGatekeeperHostBinding())
    const layer: LayerNs.Layer<MessageHandler.TagId<'Gatekeeper', 'Host'>> =
      result.current.receiverLayer

    // Re-derive the tag instance so we can read it out of the built context.
    const tag = Context.GenericTag<
      MessageHandler.TagId<'Gatekeeper', 'Host'>,
      Record<string, never>
    >('Gatekeeper.Host.HandlerTag')

    const handlers = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ctx = yield* Layer.build(layer)
          return Context.get(ctx, tag)
        })
      )
    )

    expect(handlers).toEqual({})
  })
})
