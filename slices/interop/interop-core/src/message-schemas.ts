import { Schema } from 'effect'
import { makeMessageRecord } from './messages.ts'

/**
 * Native → Web: the Expo host has detected a back-navigation gesture (header
 * chevron tap, hardware back, swipe-back). The web side is expected to call
 * `navigate(-1)` (or equivalent) so the embedded SPA's history pops without
 * popping the native screen.
 */
const NativeBackRequested = Schema.parseJson(Schema.TaggedStruct('NativeBackRequested', {}))
type NativeBackRequested = Schema.Schema.Type<typeof NativeBackRequested>

/**
 * Native → Web: the host wants the embedded SPA to navigate to `path`.
 * Two complementary use cases:
 *
 * 1. **Initial route.** The host pre-encodes one of these into
 *    `__INITIAL_MESSAGES__` so the web aggregator can synchronously
 *    `consumeBuffered('AppNavigationRequested')` before mounting the
 *    router and seed `<MemoryRouter initialEntries={[path]}>`. No
 *    placeholder-route flicker.
 * 2. **Runtime navigation.** A live `AppNavigationRequested` after
 *    mount is delivered to a listener that calls the embedded router's
 *    imperative `navigate(path)` — useful for host-driven deep links.
 *
 * (The complementary "page asks the host to push the *native* router"
 * direction is reserved for a future tag — the web side currently has
 * no consumer that needs it.)
 */
const AppNavigationRequested = Schema.parseJson(
  Schema.TaggedStruct('AppNavigationRequested', { path: Schema.String })
)
type AppNavigationRequested = Schema.Schema.Type<typeof AppNavigationRequested>

/**
 * Web → Native: the embedded SPA's router state has changed. `canGoBack`
 * drives the native screen header's back chevron; `pathname` is informational
 * (used by the host for analytics or deep-link continuity).
 */
const RouteChanged = Schema.parseJson(
  Schema.TaggedStruct('RouteChanged', {
    pathname: Schema.String,
    canGoBack: Schema.Boolean,
  })
)
type RouteChanged = Schema.Schema.Type<typeof RouteChanged>

/**
 * Slice-neutral messages flowing Native → Web. Slices compose this with their
 * own `<Slice>NativeToWeb` records via spread when wiring the aggregator.
 */
const InteropNativeToWeb = makeMessageRecord([
  ['NativeBackRequested', NativeBackRequested],
  ['AppNavigationRequested', AppNavigationRequested],
] as const)
type InteropNativeToWeb = typeof InteropNativeToWeb

/** Slice-neutral messages flowing Web → Native. Composes with slice records via spread. */
const InteropWebToNative = makeMessageRecord([['RouteChanged', RouteChanged]] as const)
type InteropWebToNative = typeof InteropWebToNative

export {
  AppNavigationRequested,
  InteropNativeToWeb,
  InteropWebToNative,
  NativeBackRequested,
  RouteChanged,
}
export type {
  AppNavigationRequested as AppNavigationRequestedType,
  NativeBackRequested as NativeBackRequestedType,
  RouteChanged as RouteChangedType,
}
