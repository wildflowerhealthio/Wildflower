import type { Effect, ParseResult } from 'effect'

import type { PersistFailure } from './persist-failure.ts'

/**
 * A titled resource a format binding yields from its review state — the
 * general-purpose unit the shell and the confirm step work with. The key
 * is stable across review-state changes (a kind toggle in one format must
 * not renumber resources in another), and the title is the one-line
 * display the shell shows beside each resource's include checkbox.
 *
 * @typeParam TParsed - The concrete resource type the format decodes to
 *   (FHIR for HAR and LifeLabs PDF)
 */
interface LabeledResource<TParsed> {
  readonly key: string
  readonly title: string
  readonly resource: TParsed
}

/**
 * "A file-format importer" as one first-class value: everything the shell needs
 * to turn a picked file of one format into reviewed, opt-in-written resources —
 * resource-agnostic and format-agnostic in this package, bound to a concrete
 * format and resource type in its own `*-importer-core` package.
 *
 * @typeParam TSettings - The format's per-import settings (HAR has none today, a
 *   minimal record); the shell seeds a form from {@link defaultSettings} and
 *   hands the chosen settings to {@link decode}
 * @typeParam TReview - The format's opaque review state: {@link decode} returns
 *   the initial value and the format's React body renders transitions over it;
 *   the shell holds it per file but never inspects it
 * @typeParam TParsed - The resource type this format resolves to (FHIR for HAR
 *   and LifeLabs PDF)
 * @typeParam R - The services {@link persist}'s write sink requires (the FHIR
 *   write client for HAR); stays visible so the shell provides it
 *
 * @remarks
 * The format pair (core + React) owns both the decode and the review resolution.
 * The general shell sees only {@link LabeledResource}s with per-resource
 * exclude/edit, and `TReview` is sealed by a `bind` closure at the registry so
 * the shell never names it. Only {@link persist} carries `R`: `decode` requires
 * nothing, so a preview can never reach the write client by construction.
 */
interface FileImporterDescriptor<TSettings, TReview, TParsed, R> {
  /** The format tag this descriptor binds (`'har'`, `'lifelabs-pdf'`); the registry's key. */
  readonly format: string
  /** User-facing strings the shell shows for this format. */
  readonly display: { readonly title: string; readonly description: string }
  /**
   * Tokens for the picker's `accept` attribute (`'.har'`, `'application/json'`,
   * `'.pdf'`). A hint to the OS dialog only; nothing here validates a file's
   * format — `decode` is the decision.
   */
  readonly accept: readonly string[]
  /** A valid settings value to seed a fresh import's settings form. */
  readonly defaultSettings: TSettings
  /**
   * Decode a picked file's text into the format's opaque review state. The
   * only failure is a malformed file (a `ParseError`); it requires no
   * services and writes nothing.
   */
  readonly decode: (
    fileText: string,
    settings: TSettings
  ) => Effect.Effect<TReview, ParseResult.ParseError>
  /**
   * Resolve the current review state into the labeled resources the shell
   * shows and the confirm step writes. Pure and total — never fails, never
   * requires services.
   */
  readonly resolve: (review: TReview) => Effect.Effect<readonly LabeledResource<TParsed>[]>
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

/**
 * The comma-joined `accept` attribute for a picker offering every registered
 * format — duplicates removed in first-seen order. Mirrors
 * `anonymizer-fundamentals`' helper of the same name.
 *
 * @param descriptors - The registered file-format descriptors
 * @returns The joined attribute value (`'.har,application/json,.pdf'`), or the
 *   empty string when no descriptor lists any token
 */
const acceptFor = (
  descriptors: readonly Pick<FileImporterDescriptor<never, never, never, never>, 'accept'>[]
): string => [...new Set(descriptors.flatMap((descriptor) => descriptor.accept))].join(',')

export { acceptFor }
export type { FileImporterDescriptor, LabeledResource }
