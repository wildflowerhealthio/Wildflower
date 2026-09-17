/**
 * Where a {@link PickedFile} came from: a `local` file the device holds, or a
 * `server` file already stored as a `DocumentReference` on the FHIR server.
 *
 * @packageDocumentation
 */

import { type SourceFileFhirReference, make } from './source-file-fhir-reference.ts'

type PickedFileSource =
  | { readonly _tag: 'local' }
  | { readonly _tag: 'server'; readonly reference: SourceFileFhirReference }

const local: PickedFileSource = { _tag: 'local' }

const server = (id: string): PickedFileSource => ({
  _tag: 'server',
  reference: make(id),
})

export { type PickedFileSource, local, server }
