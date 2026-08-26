import type { Option } from 'effect'

import type * as EntityDefinition from './entity-definition.ts'
import type * as Recognizer from './recognizer.ts'

/**
 * The one per-archive fact an importer is handed when building its entities:
 * the archive's own text.
 *
 * @remarks
 * Most importers ignore it — their entities are archive-independent
 * constants. It exists for an importer whose identity is *per archive* rather
 * than per URL or per fixed system: one that keys every stored exchange under
 * a session id has to derive that id deterministically from the archive
 * itself (so re-importing the same file upserts the same resources, and two
 * different archives never collide). The raw text is handed over rather than
 * a pre-derived id so each importer owns its own derivation, the same way
 * each owns its `rootOf`.
 */
interface ArchiveContext {
  /** The `.har` file's text, exactly as the import pipeline received it. */
  readonly harText: string
}

/**
 * An importer as one first-class value: its {@link Recognizer.Recognizer}
 * (so `Recognizer.resolve` can rank it against the others), plus the two
 * things an import pipeline drives once it has claimed an archive — the
 * entities to extract with, and how to read a source root off a single URL.
 *
 * @typeParam TResources - The resource type this importer's entities decode
 *   to
 *
 * @remarks
 * Extends `Recognizer` rather than wrapping it so the value is passed
 * straight to `Recognizer.resolve`, which returns the whole record — `tag`,
 * `entitiesFor`, and `rootOf` ride along, no parallel lookup by name.
 *
 * Both the entities and `rootOf` are **per-URL** by design: an importer keys
 * each resource under the root of the URL it arrived on, and `rootOf` reads
 * that same root off one URL. Neither infers a single root for the whole
 * capture, so an archive that reached several servers keeps each apart. A
 * pipeline collects the *set* of roots the archive named rather than choosing
 * one.
 *
 * `entitiesFor` is a factory over the {@link ArchiveContext} rather than a
 * static array so an importer whose identity is per-archive can derive it; an
 * importer with archive-independent entities returns its module-level
 * constant and ignores the argument.
 */
interface Importer<TResources> extends Recognizer.Recognizer {
  /** The importer's stable tag, the discriminator a preview reports. */
  readonly tag: string
  /**
   * The entities `Extraction.run` folds the archive through, given the
   * archive they will read. See {@link ArchiveContext} for why this is a
   * factory.
   */
  readonly entitiesFor: (
    archive: ArchiveContext
  ) => readonly EntityDefinition.EntityDefinition<TResources>[]
  /**
   * The source root a single URL was served from, or `None` when the URL
   * names no resource this importer understands. The per-URL primitive a
   * pipeline folds over every response to collect the archive's distinct
   * source roots.
   */
  readonly rootOf: (url: string) => Option.Option<string>
}

export type { ArchiveContext, Importer }
