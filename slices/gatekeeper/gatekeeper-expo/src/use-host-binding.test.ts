import { act, renderHook, waitFor } from '@testing-library/react-native'
import { Effect } from 'effect'
import type { HostBindings } from 'effect-messaging-core'
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

describe('useGatekeeperHostBinding handlers', () => {
  it('exposes an empty Gatekeeper Host handler record (Gatekeeper has no web→host messages)', () => {
    const { result } = renderHook(() => useGatekeeperHostBinding())
    // The single bridge's inbound handler record is the binding's
    // `handlers[0]` slot — empty, since Gatekeeper is host→web only.
    expect(result.current.handlers[0]).toEqual({})
  })
})

describe('useGatekeeperHostBinding initialMessages', () => {
  // No URL-param-encoded initial messages: the token never rides URL
  // params (it's delivered post-mount through the captured sender), so
  // the gatekeeper bridge has nothing to seed on first paint.
  it('seeds an empty list when no token is provided', () => {
    const { result } = renderHook(() => useGatekeeperHostBinding())
    expect(result.current.initialMessages[0]).toEqual([])
  })

  it('seeds an empty list when a token is provided (token never rides URL params)', () => {
    const { result } = renderHook(() => useGatekeeperHostBinding({ token: 'bearer-abc' }))
    expect(result.current.initialMessages[0]).toEqual([])
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
    // Flush the post-mount effect deterministically: a microtask is all
    // React needs to commit, and the `act` boundary catches any further
    // scheduled work. No real-timer wait — the absent-token gate is
    // synchronous in the effect body.
    await act(async () => {
      await Promise.resolve()
    })
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
