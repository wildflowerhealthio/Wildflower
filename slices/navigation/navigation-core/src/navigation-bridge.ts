import { Schema } from 'effect'
import { Bridge, UrlParamMessage } from 'effect-messaging-core'

/**
 * Host → Web: the native host detected a back-navigation gesture (header chevron,
 * hardware back, swipe-back). The web side calls `navigate(-1)` so the
 * embedded SPA's history pops without popping the native screen.
 */
const HostBackRequested = Schema.parseJson(Schema.TaggedStruct('HostBackRequested', {}))

/**
 * Host → Web: navigate the embedded SPA to `path`. Carries both the
 * pre-injected initial route (read synchronously to seed the TanStack
 * router's `createMemoryHistory({ initialEntries: [path] })`) and
 * runtime host-driven deep links.
 */
const HostRequestedWebNavigation = Schema.parseJson(
  Schema.TaggedStruct('HostRequestedWebNavigation', { path: Schema.String })
)

/**
 * Host → Web: the native safe-area insets (notch, status bar, rounded
 * corners, …) the embedded SPA must inset its top-level chrome by, in
 * CSS pixels. The host reads these from `useSafeAreaInsets()` and pushes
 * them on every page `__Ready` (so a relaunched WebView re-receives them)
 * and whenever they change. `bottom` is always `0`: the native tab bar
 * sits below the WebView and already owns the bottom inset, so the page
 * must not pad there or it would double up.
 *
 * Fields use `Schema.JsonNumber.pipe(Schema.nonNegative())`: `JsonNumber`
 * rejects the `NaN`/`Infinity` values `JSON.stringify` can't round-trip,
 * and `nonNegative` encodes the "insets are never negative" invariant.
 * Not `Schema.Int` — `useSafeAreaInsets()` can report fractional pixels.
 */
const SafeAreaInsetsChanged = Schema.parseJson(
  Schema.TaggedStruct('SafeAreaInsetsChanged', {
    top: Schema.JsonNumber.pipe(Schema.nonNegative()),
    bottom: Schema.JsonNumber.pipe(Schema.nonNegative()),
    left: Schema.JsonNumber.pipe(Schema.nonNegative()),
    right: Schema.JsonNumber.pipe(Schema.nonNegative()),
  })
)

/**
 * Host → Web: the OS colour scheme the embedded SPA should render in. The
 * host reads it from `useColorScheme()` and pushes it on every page
 * `__Ready` (so a relaunched WebView re-receives it) and whenever it
 * changes; the page applies it as an authoritative `data-color-scheme`
 * attribute the dark CSS keys off.
 *
 * Needed because WKWebView evaluates `prefers-color-scheme` as `light`
 * for `loadHTMLString` content regardless of the device appearance, so
 * the embedded SPA's dark-mode media query never matches on its own. The
 * plain web build never receives this message and stays driven by
 * `prefers-color-scheme`.
 */
const HostColorSchemeChanged = Schema.parseJson(
  Schema.TaggedStruct('HostColorSchemeChanged', { scheme: Schema.Literal('light', 'dark') })
)

/**
 * Web → Host: embedded SPA router state has changed. `canGoBack` drives
 * the native header's back chevron; `pathname` is informational.
 */
const RouteChanged = Schema.parseJson(
  Schema.TaggedStruct('RouteChanged', {
    pathname: Schema.String,
    canGoBack: Schema.Boolean,
  })
)

/**
 * Web → Host: the embedded SPA's first authed screen is ready to be
 * shown — the `beforeLoad` auth gate passed (host token received) and
 * the startup route prefetches have settled. The host reacts by hiding
 * the native splash / revealing the WebView, so the user never sees a
 * half-painted or unauthenticated frame.
 *
 * A lifecycle handshake modeled on the transport's `__Ready` control
 * message, but at the application layer (auth + data) rather than the
 * transport layer — `__Ready` says "the page can receive messages,"
 * `UIReady` says "the page has something worth showing."
 */
const UIReady = Schema.parseJson(Schema.TaggedStruct('UIReady', {}))

type NavigationBridge = Bridge.Bridge<
  'Navigation',
  {
    HostBackRequested: typeof HostBackRequested
    HostRequestedWebNavigation: typeof HostRequestedWebNavigation
    SafeAreaInsetsChanged: typeof SafeAreaInsetsChanged
    HostColorSchemeChanged: typeof HostColorSchemeChanged
  },
  {
    RouteChanged: typeof RouteChanged
    UIReady: typeof UIReady
  }
>

/**
 * Slice-neutral cross-process navigation contract. Host emits
 * `HostBackRequested`, `HostRequestedWebNavigation`,
 * `SafeAreaInsetsChanged`, and `HostColorSchemeChanged`; web emits
 * `RouteChanged` and `UIReady`. Aggregators wire this bridge into every
 * embedded WebView.
 *
 * @remarks
 * Cross-process `console.<level>(...)` mirroring is handled by the
 * shared `LogBridge` in `effect-messaging-core`; consumers compose it
 * alongside this bridge on the host side.
 */
const NavigationBridge: NavigationBridge = Bridge.make({
  name: 'Navigation',
  hostToWeb: [
    ['HostBackRequested', HostBackRequested],
    ['HostRequestedWebNavigation', HostRequestedWebNavigation],
    ['SafeAreaInsetsChanged', SafeAreaInsetsChanged],
    ['HostColorSchemeChanged', HostColorSchemeChanged],
  ] as const,
  webToHost: [
    ['RouteChanged', RouteChanged],
    ['UIReady', UIReady],
  ] as const,
  urlParams: {
    HostRequestedWebNavigation: UrlParamMessage.singleStringMessageSchema(
      'HostRequestedWebNavigation',
      'path'
    ),
    // HostBackRequested, SafeAreaInsetsChanged, and HostColorSchemeChanged
    // deliberately omitted — they're runtime-only signals pushed over the
    // live channel, never seeded through the WebView URL.
  },
})

export { NavigationBridge }
