import { Data } from 'effect'

/**
 * Which kind of server the launcher is signed in to, deciding what the authed
 * shell offers:
 *
 *  - `Wildflower` — a Wildflower server, with every Wildflower-only endpoint
 *    the shell calls (apps, settings), unless the sign-in found otherwise.
 *  - `PlainSmart` — a plain SMART on FHIR server (SMART Health IT's, say) that
 *    `main-web` signed in to. It has none of those endpoints, so the shell
 *    offers only its Home (`/fhir-home`, `home-path.ts`'s `homePathFor`). Carries the
 *    FHIR base the token is for, and the patient the token response put in
 *    context when it named one, for that Home to launch apps against.
 *
 * Decided at boot (`RenderAppOptions.serverKind`), not read off the
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

export { ServerKind }
