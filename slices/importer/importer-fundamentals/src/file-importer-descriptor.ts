import type { Effect, ParseResult } from 'effect'

import type { Extraction, HttpResponseKind, SourceDescriptor } from 'http-extraction-fundamentals'

import type { PersistFailure } from './persist-failure.ts'

/**
 * "A file-format importer" as one first-class value: everything the shell needs
 * to turn a picked file of one format into recognized, reviewed, opt-in-written
 * resources — resource-agnostic and format-agnostic in this package, bound to a
 * concrete format (HAR) and resource type (FHIR) in its own `*-importer-core`
 * package.
 *
 * @typeParam TSettings - The format's per-import settings (HAR has none today, a
 *   minimal record); the shell seeds a form from {@link defaultSettings} and
 *   hands the chosen settings to {@link decode}
 * @typeParam TParsed - The resource type this format's {@link pool} decodes to
 *   (FHIR for HAR)
 * @typeParam R - The services {@link persist}'s write sink requires (the FHIR
 *   write client for HAR); stays visible so the shell provides it
 *
 * @remarks
 * The archive-transport mirror of the collector slice's `CollectorDescriptor` —
 * one value a closed, compile-time registry lists; see this package's AGENTS.md
 * for the roles. Only {@link persist} carries `R`: `decode` requires nothing,
 * so a preview can never reach the write client by construction.
 */
interface FileImporterDescriptor<TSettings, TParsed, R> {
  /** The format tag this descriptor binds (`'har'`); the registry's key. */
  readonly format: string
  /** User-facing strings the shell shows for this format. */
  readonly display: { readonly title: string; readonly description: string }
  /** A valid settings value to seed a fresh import's settings form. */
  readonly defaultSettings: TSettings
  /**
   * The sources this format's {@link pool} is assembled from, each grouping its
   * own response kinds under a user-facing `name` and `display` detail. A
   * source-labelled review menu reads these; {@link pool} is exactly these
   * flattened, so a menu grouped by source and the recognizer route can never
   * disagree on which kinds exist.
   */
  readonly sources: readonly SourceDescriptor.SourceDescriptor<TParsed>[]
  /**
   * The flat pool of response kinds a decoded file's responses are recognized
   * and decoded through, routed per response by highest specificity. Exactly
   * {@link sources}' `responseKinds` flattened.
   */
  readonly pool: readonly HttpResponseKind.HttpResponseKind<TParsed>[]
  /**
   * Decode a picked file's text into the structural responses the recognizer
   * reads. The only failure is a malformed file (a `ParseError`); it requires
   * no services and writes nothing.
   */
  readonly decode: (
    fileText: string,
    settings: TSettings
  ) => Effect.Effect<readonly Extraction.Input[], ParseResult.ParseError>
  /**
   * Write the reviewed, chosen resources to this format's target, stamping each
   * with the source archive `sourceRef`. Returns the resources it could not
   * write as {@link PersistFailure} data on a `never` error channel — one bad
   * write never stops the rest.
   */
  readonly persist: (
    resources: readonly TParsed[],
    sourceRef: string
  ) => Effect.Effect<readonly PersistFailure[], never, R>
}

export type { FileImporterDescriptor }
