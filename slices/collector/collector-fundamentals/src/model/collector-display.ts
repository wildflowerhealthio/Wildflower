/**
 * User-facing strings for one collector. Kept React-free here so the
 * descriptor stays importable by pure/native layers; `collector-react`
 * (stage 3A) consumes these to render the account list and the
 * "connect from" menu instead of the display strings currently
 * hardcoded in its routes.
 *
 * - `title`: the collector kind's name (e.g. "FHIR R4"). Distinct from
 *   a *remote's* user-chosen name and from a route's demo-entry label.
 * - `description`: one-line summary of what the collector imports.
 * - `listSubtitle`: derives the per-instance subtitle from a concrete
 *   config (e.g. the configured server URL). A function rather than a
 *   field because the salient detail differs per collector — the FHIR
 *   collector shows its `rootUrl`, a credential-based collector has no
 *   URL to show.
 */
interface CollectorDisplay<Config> {
  readonly title: string
  readonly description: string
  readonly listSubtitle: (config: Config) => string
}

export type { CollectorDisplay }
