import { Data } from 'effect'

import * as FhirRoot from './fhir-root.ts'

/**
 * The source a batch of resources was imported from: what decides the system
 * each of its records' source ids belongs to.
 *
 * @remarks
 * A record is keyed by (system, resource type, source id). Its local id is
 * `localResourceId` of that key, and its source identifier is
 * `{ system, value: <source id> }`, so every system is an absolute URI that
 * `new URL` accepts.
 *
 * - `FhirServer`: a FHIR server at `root`. Its ids are unique per type, so a
 *   `Patient`'s system is `<root>/Patient` ({@link FhirRoot.systemFor}).
 * - `OneSystem`: a source that keys every type in the one `system`, a
 *   Wildflower-minted `…/fhir/sid/<source>` URI for a portal, or a format's
 *   coding system for a picked source file.
 *
 * Structurally `http-extraction-fundamentals`' `RecognizedUrlData.source`,
 * which stays FHIR-free: each response kind's `tryRecognize` mints one of
 * these, and adoption reads it as its own.
 */
type Type = Data.TaggedEnum<{
  FhirServer: { readonly root: string }
  OneSystem: { readonly system: string }
}>

const { FhirServer, OneSystem, $match } = Data.taggedEnum<Type>()

/**
 * The system `source` keys its records of `resourceType` in: where a record,
 * or a reference's target, of that type belongs.
 */
const systemFor = (source: Type, resourceType: string): string =>
  $match(source, {
    FhirServer: ({ root }) => FhirRoot.systemFor(root, resourceType),
    OneSystem: ({ system }) => system,
  })

export { $match, FhirServer, OneSystem, systemFor }
export type { Type }
