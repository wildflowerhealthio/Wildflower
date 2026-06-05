import { Effect, type Schema } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import type { NavigationBridge } from 'navigation-core'

/** Navigation target: `-1` is the back-step sentinel; a string is a path push. */
type NavTarget = -1 | string

/** Safe-area insets in CSS pixels, as carried by `SafeAreaInsetsChanged`. */
interface SafeAreaInsets {
  readonly top: number
  readonly bottom: number
  readonly left: number
  readonly right: number
}

/**
 * OS colour scheme, as carried by `HostColorSchemeChanged`. Derived from the
 * bridge schema so it tracks `Schema.Literal('light', 'dark')` from one
 * source rather than hand-redeclaring the wire union.
 */
type ColorScheme = Schema.Schema.Type<
  (typeof NavigationBridge)['HostToWeb']['HostColorSchemeChanged']
>['scheme']

/**
 * Build the Web-side inbound handler record for {@link NavigationBridge},
 * closing handlers over the supplied `navigate`, `applyInsets`, and
 * `applyColorScheme` functions. Call this inside a React component that
 * has access to `useNavigate()` (or a stable proxy that delegates to the
 * latest `useNavigate` result), then hand the resulting record to
 * `BridgeTransport.makeWebTransport`'s `handlers`.
 *
 * `applyInsets` receives the host's safe-area insets and `applyColorScheme`
 * the host's OS colour scheme; the navigation slice stays DOM-agnostic, so
 * the embedding app supplies the concrete writers (e.g. padding the page's
 * root element, or setting a `data-color-scheme` attribute).
 *
 * @remarks
 * The previous implementation buffered targets in a module-level array
 * because handlers could fire before `useNavigate()` was wired. Passing a
 * stable proxy that always delegates to the latest `useNavigate` lets the
 * handler register up front and resolve the current target at dispatch
 * time, so the buffer (and its replay) is gone. A navigation message that
 * does somehow arrive before the handler is registered is dropped by the
 * transport, not queued.
 */
interface NavigationWebHandlerDeps {
  readonly navigate: (target: NavTarget) => void
  readonly applyInsets: (insets: SafeAreaInsets) => void
  readonly applyColorScheme: (scheme: ColorScheme) => void
}

const makeNavigationWebHandlers = ({
  navigate,
  applyInsets,
  applyColorScheme,
}: NavigationWebHandlerDeps): MessageHandler.HandlersFor<
  (typeof NavigationBridge)['HostToWeb']
> => ({
  HostBackRequested: () => Effect.sync(() => navigate(-1)),
  HostRequestedWebNavigation: ({ path }) => Effect.sync(() => navigate(path)),
  SafeAreaInsetsChanged: ({ top, bottom, left, right }) =>
    Effect.sync(() => applyInsets({ top, bottom, left, right })),
  HostColorSchemeChanged: ({ scheme }) => Effect.sync(() => applyColorScheme(scheme)),
})

export { makeNavigationWebHandlers }
export type { NavTarget, SafeAreaInsets, ColorScheme }
