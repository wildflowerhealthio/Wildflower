import { act, renderHook, waitFor } from '@testing-library/react-native'
import { Effect } from 'effect'
import { useNavigationHostBinding } from './use-navigation-host-binding.ts'

// Mutable inset source so a rerender can model a rotation / multitasking
// resize. The host always forces `bottom` to `0`, so the non-zero `bottom`
// here gives the bottom→0 assertions teeth.
let mockInsets: { top: number; right: number; bottom: number; left: number }

// The binding reads its sender through `useNavigationSenderRef` (the
// app's navigation pipe). Mocking it to a plain ref lets us record every
// push without standing up the real context provider; `onPageReady`
// overwrites `.current`, and the rotation effect calls whatever `.current`
// currently is — exactly the production wiring.
let mockSent: Array<{ readonly _tag: string; readonly [k: string]: unknown }>
const recordingSend = (msg: {
  readonly _tag: string
  readonly [k: string]: unknown
}): Effect.Effect<void> => Effect.sync(() => mockSent.push(msg))
const mockSenderRef: {
  current: (msg: { readonly _tag: string; readonly [k: string]: unknown }) => Effect.Effect<void>
} = { current: recordingSend }

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: (): { top: number; right: number; bottom: number; left: number } => mockInsets,
}))
jest.mock('./navigation-pipe.tsx', () => ({
  useNavigationSenderRef: (): typeof mockSenderRef => mockSenderRef,
}))

// The real `navigation-expo` bundle resolves `@effect/platform` →
// `MsgPack` → `msgpackr`, which ships as native ESM and trips jest-expo's
// default transform. We don't exercise the real slice binding here —
// only the wrapper's rotation effect and onPageReady wiring — so a
// shape-mock that surfaces the wrapper's `options.onPageReady` is
// enough. Mirrors `app-shell-webview.test.tsx`'s `navigation-expo` mock.
jest.mock('navigation-expo', () => ({
  NavigationBridgeExpo: {
    useHostBinding: (options: {
      readonly onPageReady?: (
        send: (msg: { readonly _tag: string; readonly [k: string]: unknown }) => Effect.Effect<void>
      ) => Effect.Effect<void>
    }): {
      readonly bridges: ReadonlyArray<{ readonly name: string }>
      readonly handlers: ReadonlyArray<unknown>
      readonly initialMessages: ReadonlyArray<ReadonlyArray<unknown>>
      readonly onPageReady: ReadonlyArray<
        | ((
            send: (msg: {
              readonly _tag: string
              readonly [k: string]: unknown
            }) => Effect.Effect<void>
          ) => Effect.Effect<void>)
        | undefined
      >
    } => ({
      bridges: [{ name: 'Navigation' }],
      handlers: [{}],
      initialMessages: [[]],
      onPageReady: [options.onPageReady],
    }),
  },
}))

const noop = (): void => {}

beforeEach(() => {
  mockInsets = { top: 10, right: 4, bottom: 20, left: 6 }
  mockSent = []
  mockSenderRef.current = recordingSend
})

describe('useNavigationHostBinding rotation effect', () => {
  it('does not push insets before onPageReady has fired (ready gate)', () => {
    // `pageReadyRef` starts false: until the page signals `__Ready` and
    // onPageReady installs the real sender, the rotation effect must
    // short-circuit. Otherwise a pre-ready inset change would push through
    // the pipe's warn-and-drop default.
    const { rerender } = renderHook<ReturnType<typeof useNavigationHostBinding>, void>(() =>
      useNavigationHostBinding(noop, noop)
    )
    expect(mockSent).toEqual([])

    mockInsets = { top: 99, right: 4, bottom: 20, left: 6 }
    rerender()

    expect(mockSent).toEqual([])
  })

  it('re-pushes insets (bottom forced to 0) when they change after the page is ready', async () => {
    const { result, rerender } = renderHook<ReturnType<typeof useNavigationHostBinding>, void>(() =>
      useNavigationHostBinding(noop, noop)
    )
    const onReady = result.current.onPageReady[0]
    if (onReady === undefined) throw new Error('navigation onPageReady should be defined')

    // Page becomes ready: onPageReady captures the sender and pushes the
    // current insets once, forcing `bottom` to 0.
    await act(async () => {
      await Effect.runPromise(onReady(recordingSend))
    })
    expect(mockSent).toEqual([
      { _tag: 'SafeAreaInsetsChanged', top: 10, bottom: 0, left: 6, right: 4 },
    ])

    // Rotation: `top` changes mid-session, so the effect re-pushes.
    mockInsets = { top: 30, right: 4, bottom: 20, left: 6 }
    rerender()

    await waitFor(() => {
      expect(mockSent).toEqual([
        { _tag: 'SafeAreaInsetsChanged', top: 10, bottom: 0, left: 6, right: 4 },
        { _tag: 'SafeAreaInsetsChanged', top: 30, bottom: 0, left: 6, right: 4 },
      ])
    })
  })
})
