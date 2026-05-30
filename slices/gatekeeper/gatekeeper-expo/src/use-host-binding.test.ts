import { act, renderHook, waitFor } from '@testing-library/react-native'
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
  // The binding always wires an `onTransportReady` callback — its job is
  // to capture the typed sender into a ref so the post-mount token
  // delivery effect can call it. The "no work to do" branch is the
  // body of the effect, not the absence of the callback.
  it('is defined regardless of whether a token is provided', () => {
    const noToken = renderHook(() => useGatekeeperHostBinding())
    expect(noToken.result.current.onTransportReady[0]).toBeDefined()

    const withToken = renderHook(() => useGatekeeperHostBinding({ token: 'bearer-xyz' }))
    expect(withToken.result.current.onTransportReady[0]).toBeDefined()
  })

  it('captures the sender but sends nothing when no token is provided', async () => {
    const { result } = renderHook(() => useGatekeeperHostBinding())
    const onReady = result.current.onTransportReady[0]
    if (onReady === undefined) throw new Error('onTransportReady should be defined')

    const sent: Array<{ readonly _tag: string }> = []
    const fakeSend = (msg: {
      readonly _tag: string
      readonly [k: string]: unknown
    }): Effect.Effect<void> => Effect.sync(() => sent.push(msg))

    await act(async () => {
      await Effect.runPromise(onReady(fakeSend))
    })
    // Give the post-mount effect a tick to run if it were going to —
    // the absent token should gate the send away.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sent).toEqual([])
  })

  it('sends AuthTokenIssued via the captured sender once both transport-ready and token are available', async () => {
    const { result } = renderHook(() => useGatekeeperHostBinding({ token: 'bearer-xyz' }))
    const onReady = result.current.onTransportReady[0]
    if (onReady === undefined) throw new Error('onTransportReady should be defined')

    const sent: Array<{ readonly _tag: string }> = []
    const fakeSend = (msg: {
      readonly _tag: string
      readonly [k: string]: unknown
    }): Effect.Effect<void> => Effect.sync(() => sent.push(msg))

    await act(async () => {
      await Effect.runPromise(onReady(fakeSend))
    })
    await waitFor(() => {
      expect(sent).toEqual([{ _tag: 'AuthTokenIssued', token: 'bearer-xyz' }])
    })
  })

  it('keeps binding identity stable across token transitions (no transport rebuild)', async () => {
    // Cold-start regression guard: the previous [token]-keyed memo
    // returned a fresh binding when the host's token minted after the
    // initial render, which tore down the transport and rebuilt the
    // WebView. The new design folds token delivery into a post-mount
    // effect, so the binding reference must be identity-stable across
    // the undefined → string transition.
    const { result, rerender } = renderHook(
      ({ token }: { token: string | undefined }) => useGatekeeperHostBinding({ token }),
      { initialProps: { token: undefined as string | undefined } }
    )
    const first = result.current
    rerender({ token: 'bearer-xyz' })
    expect(result.current).toBe(first)
  })

  it('sends a fresh AuthTokenIssued when token rotates after transport is ready', async () => {
    const { result, rerender } = renderHook(
      ({ token }: { token: string | undefined }) => useGatekeeperHostBinding({ token }),
      { initialProps: { token: 'bearer-old' as string | undefined } }
    )
    const onReady = result.current.onTransportReady[0]
    if (onReady === undefined) throw new Error('onTransportReady should be defined')

    const sent: Array<{ readonly _tag: string }> = []
    const fakeSend = (msg: {
      readonly _tag: string
      readonly [k: string]: unknown
    }): Effect.Effect<void> => Effect.sync(() => sent.push(msg))

    await act(async () => {
      await Effect.runPromise(onReady(fakeSend))
    })
    await waitFor(() => {
      expect(sent).toEqual([{ _tag: 'AuthTokenIssued', token: 'bearer-old' }])
    })

    rerender({ token: 'bearer-new' })
    await waitFor(() => {
      expect(sent).toEqual([
        { _tag: 'AuthTokenIssued', token: 'bearer-old' },
        { _tag: 'AuthTokenIssued', token: 'bearer-new' },
      ])
    })
  })
})
