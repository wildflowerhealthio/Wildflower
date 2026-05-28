import { renderHook } from '@testing-library/react-native'
import { Context, Effect, Layer, type Layer as LayerNs } from 'effect'
import type { HostBindings, MessageHandler } from 'effect-messaging-core'
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
  HostBindings.HostBindings<readonly [typeof GatekeeperBridge]>
>()
expectTypeOf(useGatekeeperHostBinding).parameters.toEqualTypeOf<
  [({ readonly token?: string } | undefined)?]
>()

describe('useGatekeeperHostBinding receiverLayer', () => {
  it('builds at runtime and provides the Gatekeeper Host handler tag with no message handlers (Gatekeeper has no web→host messages)', async () => {
    const { result } = renderHook(() => useGatekeeperHostBinding())
    const layer: LayerNs.Layer<MessageHandler.TagId<'Gatekeeper', 'Host'>> =
      result.current.receiverLayers[0]

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

describe('useGatekeeperHostBinding initialMessages', () => {
  // `WaitForToken` is unconditional — the embedded SPA needs it to
  // distinguish "token coming" from "no host" regardless of whether
  // the host already has a token in hand.
  it('seeds [{ _tag: "WaitForToken" }] when no token is provided', () => {
    const { result } = renderHook(() => useGatekeeperHostBinding())
    expect(result.current.initialMessages[0]).toEqual([{ _tag: 'WaitForToken' }])
  })

  it('seeds [{ _tag: "WaitForToken" }] when a token is provided (token never rides URL params)', () => {
    const { result } = renderHook(() => useGatekeeperHostBinding({ token: 'bearer-abc' }))
    expect(result.current.initialMessages[0]).toEqual([{ _tag: 'WaitForToken' }])
  })
})

describe('useGatekeeperHostBinding onTransportReady', () => {
  it('is undefined when no token is provided (no post-mount work to do)', () => {
    const { result } = renderHook(() => useGatekeeperHostBinding())
    expect(result.current.onTransportReady[0]).toBeUndefined()
  })

  it('issues AuthTokenIssued through the binding sender when a token is provided', async () => {
    const { result } = renderHook(() => useGatekeeperHostBinding({ token: 'bearer-xyz' }))
    const onReady = result.current.onTransportReady[0]
    if (onReady === undefined)
      throw new Error('onTransportReady should be defined when token is set')

    const sent: Array<{ readonly _tag: string }> = []
    const fakeSend = (msg: {
      readonly _tag: string
      readonly [k: string]: unknown
    }): Effect.Effect<void> => Effect.sync(() => sent.push(msg))

    await Effect.runPromise(onReady(fakeSend))
    expect(sent).toEqual([{ _tag: 'AuthTokenIssued', token: 'bearer-xyz' }])
  })
})
