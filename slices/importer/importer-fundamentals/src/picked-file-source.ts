/**
 * Where a picked file came from, and the two constructors that say so.
 *
 * @remarks
 * Its own module rather than a namespace nested inside `picked-file.ts`: both
 * it and the picked file itself call their main type `Type`, which is the
 * convention every namespace here follows, and one module cannot hold two.
 * Consumed as `PickedFile.Source`, which `picked-file.ts` re-exports.
 *
 * @packageDocumentation
 */

import * as SourceFile from './source-file.ts'

/**
 * A `local` file the device holds, or a `server` file already stored as a
 * `DocumentReference` on the FHIR server.
 *
 * @remarks
 * The provenance rides along with every pick because a format's decode owns
 * the source-file `DocumentReference`: for a `local` pick it mints one (and
 * stamps every extracted resource's `meta.source` with it), and for a `server`
 * pick it mints nothing and stamps the existing `reference`.
 */
type Type =
  | { readonly _tag: 'local' }
  | { readonly _tag: 'server'; readonly reference: SourceFile.Reference }

/** A file the device holds; its decode mints the source file. */
const local: Type = { _tag: 'local' }

/**
 * A source file already on the FHIR server; its decode mints nothing.
 *
 * @param id - The stored source file's logical id
 * @returns The provenance, carrying the reference the decode stamps with
 */
const server = (id: string): Type => ({
  _tag: 'server',
  reference: SourceFile.makeReference(id),
})

export { local, server }
export type { Type }
