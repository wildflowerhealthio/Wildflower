import type { Option } from 'effect'

import type { EntityDefinition } from 'collector-fundamentals/model'
import type { Recognizer } from 'collector-fundamentals/replay'
import { fhirR4Recognizer, fhirRootOf, offlineEntities } from 'fhir-r4-importer'
import type { FhirResource } from 'fhir-r4/resources'

/**
 * The closed, compile-time list of collectors an archive import can be replayed
 * against — the offline counterpart of `collector-registry`'s `descriptors`
 * tuple.
 *
 * @remarks
 * Only `fhir-r4` is registered so far; the shape leaves room for the ranking
 * its recognizer reserves a seat in (Rexall > FHIR > web-trace). Registering a
 * collector here is one static edit — appending a {@link RegisteredCollector}
 * record — mirroring the two-edit descriptor seam on the live side. There is no
 * runtime registry.
 */

/**
 * The one per-archive fact the registry hands a collector when building its
 * offline entities: the archive's own text.
 *
 * @remarks
 * Most collectors ignore it — their entities are archive-independent constants.
 * It exists for a collector whose offline identity is *per archive* rather than
 * per URL or per fixed system: `web-trace`'s recorder keys every stored
 * exchange under a session id, and an imported archive's session id has to be a
 * deterministic function of the archive itself (so re-importing the same file
 * upserts the same resources, and two different archives never collide). The
 * raw text is handed over rather than a pre-derived id so each collector owns
 * its own derivation, the same way each owns its `rootOf`.
 */
interface ArchiveContext {
  /** The `.har` file's text, exactly as `runHarImport` received it. */
  readonly harText: string
}

/**
 * A collector as the importer sees it: its {@link Recognizer} (so
 * `Recognizer.resolve` can rank it against the others), plus the two things the
 * import pipeline drives once it has claimed an archive — the offline entities
 * to replay, and how to read a source root off a single URL.
 *
 * @remarks
 * Extends `Recognizer` rather than wrapping it so the record is passed straight
 * to `Recognizer.resolve`, which returns the whole record — `tag`,
 * `offlineEntitiesFor`, and `rootOf` ride along, no parallel lookup by name.
 *
 * Both the offline entities and `rootOf` are **per-URL** by design: the FHIR R4
 * surface keys each resource under the root of the URL it arrived on, and
 * `rootOf` reads that same root off one URL. Neither infers a single root for
 * the whole capture, so an archive that reached several servers keeps each
 * apart. The importer collects the *set* of roots the archive named rather than
 * choosing one.
 *
 * `offlineEntitiesFor` is a factory over the {@link ArchiveContext} rather than
 * a static array so a collector whose identity is per-archive (`web-trace`'s
 * session id) can derive it; a collector with archive-independent entities
 * returns its module-level constant and ignores the argument.
 */
interface RegisteredCollector extends Recognizer.Recognizer {
  /** The collector's stable tag, the discriminator a preview reports. */
  readonly tag: 'fhir-r4'
  /**
   * The offline entities `Replay.replayEntities` folds the archive through,
   * given the archive they will replay. See {@link ArchiveContext} for why this
   * is a factory.
   */
  readonly offlineEntitiesFor: (
    archive: ArchiveContext
  ) => readonly EntityDefinition.EntityDefinition<FhirResource>[]
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
 * `Preview` reports as `collectorTag`; `rootOf` is `fhir-r4-importer`'s
 * `fhirRootOf`, the per-URL root primitive the offline entities key on, so the
 * importer reads a source root exactly the way the entities do. The entities
 * are archive-independent, so `offlineEntitiesFor` ignores its argument and
 * returns the module-level constant.
 */
const fhirR4Registered: RegisteredCollector = {
  ...fhirR4Recognizer,
  tag: 'fhir-r4',
  offlineEntitiesFor: () => offlineEntities,
  rootOf: fhirRootOf,
}

/** Every collector an archive import can be replayed against. Closed. */
const REGISTERED_COLLECTORS: readonly RegisteredCollector[] = [fhirR4Registered]

export { type ArchiveContext, fhirR4Registered, REGISTERED_COLLECTORS, type RegisteredCollector }
