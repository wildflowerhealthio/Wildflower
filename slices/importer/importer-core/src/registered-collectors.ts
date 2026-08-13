import type { Option } from 'effect'

import type { EntityDefinition } from 'collector-fundamentals/model'
import type { Recognizer } from 'collector-fundamentals/replay'
import { fhirR4Recognizer, fhirRootOf, offlineEntities } from 'fhir-r4-client-collector'
import type { FhirResource } from 'fhir-r4/resources'

/**
 * The closed, compile-time list of collectors an archive import can be replayed
 * against — the offline counterpart of `collector-registry`'s `descriptors`
 * tuple.
 *
 * @remarks
 * Only `fhir-r4` is registered this epic; the shape leaves room for the ranking
 * its recognizer reserves a seat in (Rexall > FHIR > web-trace). Registering a
 * collector here is one static edit — appending a {@link RegisteredCollector}
 * record — mirroring the two-edit descriptor seam on the live side. There is no
 * runtime registry.
 */

/**
 * A collector as the importer sees it: its {@link Recognizer} (so
 * `Recognizer.resolve` can rank it against the others), plus the two things the
 * import pipeline drives once it has claimed an archive — the offline entities
 * to replay, and how to read a source root off a single URL.
 *
 * @remarks
 * Extends `Recognizer` rather than wrapping it so the record is passed straight
 * to `Recognizer.resolve`, which returns the whole record — `tag`,
 * `offlineEntities`, and `rootOf` ride along, no parallel lookup by name.
 *
 * Both `offlineEntities` and `rootOf` are **per-URL** by design: the FHIR R4
 * surface keys each resource under the root of the URL it arrived on, and
 * `rootOf` reads that same root off one URL. Neither infers a single root for
 * the whole capture, so an archive that reached several servers keeps each
 * apart. The importer collects the *set* of roots the archive named rather than
 * choosing one.
 */
interface RegisteredCollector extends Recognizer.Recognizer {
  /** The collector's stable tag, the discriminator a preview reports. */
  readonly tag: 'fhir-r4'
  /** The offline entities `Replay.replayEntities` folds the archive through. */
  readonly offlineEntities: readonly EntityDefinition.EntityDefinition<FhirResource>[]
  /**
   * The source root a single URL was served from, or `None` when the URL names
   * no resource this collector understands. The per-URL primitive the importer
   * folds over every response to collect the archive's distinct source roots.
   */
  readonly rootOf: (url: string) => Option.Option<string>
}

/**
 * The FHIR R4 offline collector, as the one registered import target.
 *
 * @remarks
 * Spreads `fhirR4Recognizer` for its `name`/`specificity`/`claims`, then adds
 * the import-side fields. `tag` is the literal `'fhir-r4'`, the discriminator a
 * `Preview` reports as `collectorTag`; `rootOf` is `fhir-r4-client-collector`'s
 * `fhirRootOf`, the per-URL root primitive the offline entities key on, so the
 * importer reads a source root exactly the way the entities do.
 */
const fhirR4Registered: RegisteredCollector = {
  ...fhirR4Recognizer,
  tag: 'fhir-r4',
  offlineEntities,
  rootOf: fhirRootOf,
}

/** Every collector an archive import can be replayed against. Closed. */
const REGISTERED_COLLECTORS: readonly RegisteredCollector[] = [fhirR4Registered]

export { fhirR4Registered, REGISTERED_COLLECTORS, type RegisteredCollector }
