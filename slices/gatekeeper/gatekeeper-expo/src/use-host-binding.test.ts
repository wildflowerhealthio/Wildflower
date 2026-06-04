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
  // params (it's delivered post-page-ready through the captured sender),
  // so the gatekeeper bridge has nothing to seed on first paint.
  it('seeds an empty list when no token is provided', () => {
    const { result } = renderHook(() => useGatekeeperHostBinding())
    expect(result.current.initialMessages[0]).toEqual([])
  })

  it('seeds an empty list when a token is provided (token never rides URL params)', () => {
    const { result } = renderHook(() => useGatekeeperHostBinding({ token: 'bearer-abc' }))
    expect(result.current.initialMessages[0]).toEqual([])
  })
})

// Shared probe for the captured sender. The hook's onPageReady receives
// a typed sender and the rotation effect calls the same sender via the
// captured ref; the probe records every payload so per-test assertions
// can reason about both paths uniformly.
const makeFakeSend = (): {
  readonly fakeSend: (msg: {
    readonly _tag: string
    readonly [k: string]: unknown
  }) => Effect.Effect<void>
  readonly sent: Array<{ readonly _tag: string }>
} => {
  const sent: Array<{ readonly _tag: string }> = []
  const fakeSend = (msg: {
    readonly _tag: string
    readonly [k: string]: unknown
  }): Effect.Effect<void> => Effect.sync(() => sent.push(msg))
  return { fakeSend, sent }
}

describe('useGatekeeperHostBinding onPageReady', () => {
  // The binding always wires an `onPageReady` callback — its job is to
  // capture the typed sender into a ref AND push the current token (so
  // every page (re)load receives a fresh credential, even reloads that
  // don't change `token` from the host's perspective).
  it('is defined regardless of whether a token is provided', () => {
    const noToken = renderHook(() => useGatekeeperHostBinding())
    expect(noToken.result.current.onPageReady[0]).toBeDefined()

    const withToken = renderHook(() => useGatekeeperHostBinding({ token: 'bearer-xyz' }))
    expect(withToken.result.current.onPageReady[0]).toBeDefined()
  })

  it('captures the sender but sends nothing when no token is provided', async () => {
    const { result } = renderHook(() => useGatekeeperHostBinding())
    const onReady = result.current.onPageReady[0]
    if (onReady === undefined) throw new Error('onPageReady should be defined')
    const { fakeSend, sent } = makeFakeSend()

    await act(async () => {
      await Effect.runPromise(onReady(fakeSend))
    })
    // No microtask gap to flush — token delivery is inside the
    // onPageReady Effect itself now, and the absent-token guard is
    // synchronous. Asserting immediately pins that.
    expect(sent).toEqual([])
  })

  it('sends AuthTokenIssued via the captured sender immediately when a token is already present', async () => {
    const { result } = renderHook(() => useGatekeeperHostBinding({ token: 'bearer-xyz' }))
    const onReady = result.current.onPageReady[0]
    if (onReady === undefined) throw new Error('onPageReady should be defined')
    const { fakeSend, sent } = makeFakeSend()

    await act(async () => {
      await Effect.runPromise(onReady(fakeSend))
    })
    expect(sent).toEqual([{ _tag: 'AuthTokenIssued', token: 'bearer-xyz' }])
  })

  it('re-sends the current token on every onPageReady fire (page reload re-delivery)', async () => {
    // This is the symptom the rename fixes: a WebView reload (Android
    // blank-page workaround remount, Metro refresh, etc.) re-runs the
    // page from scratch, the page posts `__Ready` again, and the
    // transport invokes `onPageReady` again. Without this re-fire path
    // the freshly-loaded SPA would block on the auth gate forever — the
    // host's `transportReady` flag is still true so the old
    // `[token, transportReady]` effect didn't re-fire, and `token`
    // hasn't changed.
    const { result } = renderHook(() => useGatekeeperHostBinding({ token: 'bearer-xyz' }))
    const onReady = result.current.onPageReady[0]
    if (onReady === undefined) throw new Error('onPageReady should be defined')
    const { fakeSend, sent } = makeFakeSend()

    await act(async () => {
      await Effect.runPromise(onReady(fakeSend))
      await Effect.runPromise(onReady(fakeSend))
      await Effect.runPromise(onReady(fakeSend))
    })
    expect(sent).toEqual([
      { _tag: 'AuthTokenIssued', token: 'bearer-xyz' },
      { _tag: 'AuthTokenIssued', token: 'bearer-xyz' },
      { _tag: 'AuthTokenIssued', token: 'bearer-xyz' },
    ])
  })

  it('reads the current token via the ref when onPageReady fires after the host has minted (cold-start ordering)', async () => {
    // Cold-start ordering: the host's bootstrap mints the token
    // *before* the WebView's first page posts `__Ready`. The rotation
    // effect saw the new value but the sender wasn't captured yet
    // (short-circuited on `senderRef === null`); the first onPageReady
    // fire is what delivers the token, via the ref read at fire time.
    const { result, rerender } = renderHook(
      ({ token }: { token: string | undefined }) => useGatekeeperHostBinding({ token }),
      { initialProps: { token: undefined as string | undefined } }
    )
    const onReady = result.current.onPageReady[0]
    if (onReady === undefined) throw new Error('onPageReady should be defined')
    const { fakeSend, sent } = makeFakeSend()

    // Mint the token before the page posts ready. The rotation effect
    // runs here but the sender is still null inside the binding, so
    // nothing escapes.
    rerender({ token: 'bearer-xyz' })
    expect(sent).toEqual([])

    // Now the page posts __Ready: onPageReady captures the sender and
    // pushes the current (already-minted) token through.
    await act(async () => {
      await Effect.runPromise(onReady(fakeSend))
    })
    expect(sent).toEqual([{ _tag: 'AuthTokenIssued', token: 'bearer-xyz' }])
  })
})

describe('useGatekeeperHostBinding token-rotation effect', () => {
  // Complement to the onPageReady re-fire path: the rotation effect
  // covers tokens that change *while a page is live* (no reload), so
  // the SPA receives a fresh credential without waiting for its next
  // boot. Both paths share the same captured sender ref.
  it('sends a fresh AuthTokenIssued when token rotates after onPageReady has fired', async () => {
    const { result, rerender } = renderHook(
      ({ token }: { token: string | undefined }) => useGatekeeperHostBinding({ token }),
      { initialProps: { token: 'bearer-old' as string | undefined } }
    )
    const onReady = result.current.onPageReady[0]
    if (onReady === undefined) throw new Error('onPageReady should be defined')
    const { fakeSend, sent } = makeFakeSend()

    await act(async () => {
      await Effect.runPromise(onReady(fakeSend))
    })
    expect(sent).toEqual([{ _tag: 'AuthTokenIssued', token: 'bearer-old' }])

    rerender({ token: 'bearer-new' })
    await waitFor(() => {
      expect(sent).toEqual([
        { _tag: 'AuthTokenIssued', token: 'bearer-old' },
        { _tag: 'AuthTokenIssued', token: 'bearer-new' },
      ])
    })
  })

  it('absorbs token rotations that fire before the page has signalled ready (no crash, no spurious send)', async () => {
    // The rotation effect runs on every `token` change; until the page
    // posts `__Ready` and onPageReady captures the sender, the effect
    // short-circuits on the null sender. The next onPageReady fire
    // picks the rotated value up via `tokenRef`.
    const { result, rerender } = renderHook(
      ({ token }: { token: string | undefined }) => useGatekeeperHostBinding({ token }),
      { initialProps: { token: 'bearer-old' as string | undefined } }
    )
    // No onPageReady fire — the sender is still null inside the binding.
    rerender({ token: 'bearer-new' })
    // No assertion against `sent` because no sender exists to capture;
    // the meaningful contract is "doesn't throw / doesn't double-send".
    // The follow-up fire below verifies the rotated value lands.
    const onReady = result.current.onPageReady[0]
    if (onReady === undefined) throw new Error('onPageReady should be defined')
    const { fakeSend, sent } = makeFakeSend()
    await act(async () => {
      await Effect.runPromise(onReady(fakeSend))
    })
    expect(sent).toEqual([{ _tag: 'AuthTokenIssued', token: 'bearer-new' }])
  })
})

describe('useGatekeeperHostBinding identity stability', () => {
  it('keeps binding identity stable across token transitions (no transport rebuild)', () => {
    // Cold-start regression guard: the previous [token]-keyed memo
    // returned a fresh binding when the host's token minted after the
    // initial render, which tore down the transport and rebuilt the
    // WebView. The new design folds token delivery into onPageReady
    // (and a rotation useEffect), so the binding reference must be
    // identity-stable across the undefined → string transition.
    const { result, rerender } = renderHook(
      ({ token }: { token: string | undefined }) => useGatekeeperHostBinding({ token }),
      { initialProps: { token: undefined as string | undefined } }
    )
    const first = result.current
    rerender({ token: 'bearer-xyz' })
    expect(result.current).toBe(first)
  })
})
