import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import { type DateTime, Either, type ParseResult, Schema } from 'effect'

import * as Entry from './snapshot-entry.ts'
import * as SnapshotFile from './snapshot-file.ts'
import * as Header from './snapshot-header.ts'
import * as Layout from './snapshot-layout.ts'
import * as Reader from './snapshot-reader.ts'
import * as WriteOrder from './snapshot-write-order.ts'

/**
 * A snapshot of a FHIR store at one as-of date and generator commit: its
 * {@link Header} — who its members are and which entries are theirs — and its
 * entries, every resource and every file an importer read
 * ({@link Entry}), laid out from each member's importer output
 * ({@link Layout}). {@link filesOf} gives the files a static host serves it
 * as, so the step that publishes it only writes each file at its path, and
 * {@link Reader} reads them back: the header, and each resource as the import
 * wrote it, which {@link WriteOrder} orders into the batch bundles a reader
 * writes them to a FHIR server in.
 */

/** A snapshot: its header, and every entry once, in path order. */
interface Snapshot {
  readonly header: Header.Header
  readonly entries: readonly Entry.Any[]
}

/** A member and every resource the imports of their records made. */
interface MemberRecords {
  readonly member: Header.Member
  /**
   * Importer output, in the order each import wrote it, including the
   * source-file `DocumentReference` every `meta.source` among them names. A
   * resource two members share (a family account's HAR) is listed under each.
   */
  readonly resources: readonly FhirResource[]
}

const validateHeader = Schema.validateEither(Header.Schema)

/**
 * A snapshot of the members' records.
 *
 * @param asOf - The as-of instant the records were rendered for
 * @param wildflowerCommit - The Wildflower commit generating it, which the
 *   header records
 * @param members - Each member's records, in the order the header lists them
 * @returns The snapshot, identical for identical inputs; an entry two members
 *   share is held once. Fails as `Layout.layOut` does per member, with a
 *   `ConflictingFiles` when two members' entries differ at one path, or with a
 *   `ParseError` when the header is not valid (two members under one key, a
 *   key or name it does not accept)
 */
const assemble = (
  asOf: DateTime.Utc,
  wildflowerCommit: string,
  members: readonly MemberRecords[]
): Either.Either<
  Snapshot,
  Layout.UnplaceableResource | Layout.ConflictingFiles | ParseResult.ParseError
> =>
  Either.gen(function* () {
    const memberEntries = yield* Either.all(
      members.map(({ member, resources }) =>
        Layout.layOut(resources).pipe(Either.map((entries) => ({ member, entries })))
      )
    )
    const merged = yield* Layout.merge(memberEntries.map(({ entries }) => entries))
    const header = yield* validateHeader(Header.make(asOf, wildflowerCommit, memberEntries))
    return { header, entries: merged }
  })

const encodeHeader = Schema.encodeEither(Header.FileSchema)

const encodeEntry = Schema.encodeEither(Entry.FileSchema)

/**
 * Every file of a snapshot, in path order: one per entry, and `index.json`.
 *
 * @returns The files; a `ParseError` only for a resource `fhir-r4` does not
 *   encode
 */
const filesOf = (
  snapshot: Snapshot
): Either.Either<readonly SnapshotFile.Any[], ParseResult.ParseError> =>
  Either.gen(function* () {
    const header = yield* encodeHeader(snapshot.header)
    const entries = yield* Either.all(snapshot.entries.map((entry) => encodeEntry(entry)))
    return [header, ...entries].toSorted(SnapshotFile.byPath)
  })

export { assemble, Entry, filesOf, Header, Layout, Reader, WriteOrder }
export type { MemberRecords, Snapshot }
