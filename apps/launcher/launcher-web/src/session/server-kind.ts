import { Data } from 'effect'
import { createContext, useContext } from 'react'

/**
 * Which kind of server the launcher is signed in to, deciding what the authed
 * shell offers:
 *
 *  - `Wildflower` — a Wildflower server, with every Wildflower-only endpoint
 *    the shell calls (apps, collector, settings). `main-tauri` is
 *    always this, and so is `main-web` unless its sign-in found otherwise.
 *  - `PlainSmart` — a plain SMART on FHIR server (SMART Health IT's, say) that
 *    `main-web` signed in to. It has none of those endpoints, so the shell
 *    offers only its Home (`tabs.ts`'s `PLAIN_SMART_HOME_TAB`). Carries the
 *    FHIR base the token is for, and the patient the token response put in
 *    context when it named one, for that Home to launch apps against.
 *
 * Decided by the entry (`RenderAppOptions.serverKind`), not read off the
 * server: `main-web` derives it from the redeemed SMART session's
 * `gatekeeper-core` `SmartServer` (`sign-in.ts`'s `serverKindForSession`).
 * That type says what discovery found; this one says what the shell offers,
 * which is why it carries the session's patient and not a Wildflower FHIR base.
 */
type ServerKind = Data.TaggedEnum<{
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty variant
  readonly Wildflower: Record<never, never>
  readonly PlainSmart: {
    readonly fhirBaseUrl: string
    readonly patient: string | undefined
  }
}>

const ServerKind = Data.taggedEnum<ServerKind>()

/**
 * The {@link ServerKind} the tree was built for, for `<TabBar>`.
 *
 * A React context rather than TanStack router context for the reason
 * `PlatformTabsContext` gives: this app's router hooks are untyped. The route
 * guards read the same value off router context (`RouterContext.serverKind`).
 * Defaults to `Wildflower`, so a bar mounted outside a provider renders the
 * full set of tabs.
 */
const ServerKindContext = createContext<ServerKind>(ServerKind.Wildflower())

/** Read the {@link ServerKind} the tree was built for. */
const useServerKind = (): ServerKind => useContext(ServerKindContext)

export { ServerKind, ServerKindContext, useServerKind }
