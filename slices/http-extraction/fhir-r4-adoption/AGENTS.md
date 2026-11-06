# AGENTS.md — slices/http-extraction/fhir-r4-adoption

The **FHIR R4 side of extraction**: a resource a source decoded, detached
from that source, and a detached resource adopted into the device's store.
A detached resource has no id (FHIR's logical id only means something on the
server that assigned it), is keyed by its first identifier — FHIR's
`Identifier.system` and `value` — and names every other decoded record by a
logical reference; a `Binary`, which has no identifier, is named by the
server's absolute URL for it, its entry's `fullUrl`. Adopting one stores it
under a local id derived from its key and resolves each logical reference to
a record of its batch to a literal one, as a FHIR server resolves a
conditional reference against a transaction bundle, and each literal
reference or `Attachment.url` spelling an entry's `fullUrl` to that entry's
literal reference, as it resolves a reference to an entry with no
identifier. It sits above `fhir-r4` (the resource schemas and
`localResourceId`); `http-extraction-fundamentals` (the response-kind
vocabulary) stays FHIR-free and below it.

## Shape

- `src/detached-resource.ts` — `DetachedResource.Type`, `FhirResource`
  narrowed to `id: null`; `keyIdentifierOf` (the qualified `identifier[0]`,
  `None` for a keyless record, a `Binary` always) and `keyOf` (its `system`
  and `value` as a `Key`), `storedReferenceOf` (a keyed record's
  stored reference derived from its key, `<Type>/<localResourceId(…)>`), and
  `hasIdentifier` (whether the record's type has an `identifier`
  element: every `fhir-r4` schema with one defaults it to `[]`, so the
  decoded record carries the property exactly then). How a decoder writes a
  record detached: `keyIdentifierWire(key)` for its `identifier[0]`,
  `logicalReferenceWire(Type, key)` for a reference to another record, and
  `decodeUnknown(schema)` to decode that wire as a detached record, failing
  one that carries an `id`. How a kind whose response is a FHIR server's
  records detaches one: `fromServerRecord(baseUrl)` drops its `id`, prepends
  `{ system: <baseUrl>/<Type>, value: id }` as `identifier[0]` when it had one
  and the type has an `identifier` element, and turns each reference whose
  literal is a `Type/id` of an R4 resource type (`fhir-r4`'s `ResourceType`),
  relative or under `<baseUrl>/`, into the logical reference to its target by
  key, replacing any identifier the server had put on it; any other reference
  (a non-R4 token like carebook's `PrescriptionOrder` included) keeps its
  spelling and identifier. A `Binary/<id>` reference, or `Attachment.url`, is
  instead made the server's absolute URL for the Binary,
  `<baseUrl>/Binary/<id>`, its `type` and `identifier` kept: R4 gives `Binary`
  no identifier to name it by. It keeps the resource's own type.
- `src/reference-table.ts` — the per-type reference table (`mapReferences`,
  the one place a resource's references are walked) and, beside it, the
  attachment URL walk (`mapAttachmentUrls`: `Patient.photo`,
  `Practitioner.photo`, `DocumentReference.content.attachment`,
  `DiagnosticReport.presentedForm`), which `fromServerRecord` and `adopt` both
  rewrite through.
- `src/reference-plan.ts` — the **`ReferencePlan`** namespace, a plain data
  structure: for each resource type and qualified identifier, the literal
  reference a logical reference by them resolves to, and for each absolute
  `fullUrl`, the literal reference a literal reference or an `Attachment.url`
  spelling it resolves to. **`of(entries, fullUrlEntries)`** holds each
  `{ resourceType, identifier, literalReference }` and each
  **`FullUrlEntry`** `{ fullUrl, literalReference }` it is given and decides
  nothing about which go in; its builder does.
  **`literalReferenceFor(plan, Type, identifier)`** matches on the type and
  the identifier's `system` and `value` alone (spelled as JSON, so no
  separator inside either can make two collide), and is `None` for one the
  plan does not hold or holds with two different literal references: as a
  FHIR conditional reference matching several records, it is ambiguous, so
  the reference stays logical (the same entry given twice is no clash).
  **`literalReferenceForFullUrl(plan, url)`** matches an absolute URL on its
  `href`, so two spellings of one URL are one `fullUrl`, and is `None` for a
  relative URL, one the plan does not hold, or one it holds with two
  different literal references.
  **`literalReferenceIfResolved(plan, reference)`** is what a reference
  resolves to: for a literal reference, what `literalReferenceForFullUrl`
  resolves its literal to; otherwise `None` unless it is a logical reference
  (an R4 resource type, a qualified identifier) `literalReferenceFor`
  resolves.
  `adopt` writes it, and the import stage reads it to ask whether a reference
  names a record of the set.
- `src/adopt-resource.ts` — `adopt(referencePlan)(record, id)` stores a
  record under the id it is given (the import stage's resource plan decides
  it: `localResourceId(key.system, Type, key.value)` for a keyed record, a
  minted one for a keyless record, `randomResourceId`, a UUID, outside
  tests), and resolves a reference to the literal reference
  `ReferencePlan.literalReferenceIfResolved` gives it, keeping `type` and
  `identifier`, and an `Attachment.url` to the one
  `ReferencePlan.literalReferenceForFullUrl` gives it; a logical reference the
  plan does not resolve stays logical, for the importer's identity map, and a
  literal one or an attachment URL keeps its spelling, the server's URL for
  its target.
  `adoptedReferenceOf(system, Type, id)` is the literal reference the
  import stores the record with that key under, for a resource written
  outside that source; `originalIdOf(system, resource)` reads the value of a
  resource's identifier in `system` (`<baseUrl>/<Type>` for a FHIR server's
  record).

## Layering

Pure: no DOM, no `fs`, no React. Depends on `fhir-r4` and `effect`. Every
decoder writes its records with it: the source packages' response kinds
(`fhir-r4-source` and Rexall's medication list detaching a FHIR server's
records, the rest writing them detached) and the file importers
(`dicom-importer-core`, `lifelabs-pdf-importer-core`).
`importer-fundamentals`' `ResourcePlan` keys a file set's records with it and
`DecodedFileSet.adopt` builds the set's `ReferencePlan` and adopts with it, and
the synthetic-data generators spell references with it. It must never import
from `slices/importer` or `http-extraction-fundamentals`, so `adopt` takes the
import stage's decisions as plain inputs (an id, and a `ReferencePlan` of
plain entries). Nothing on the import side takes a base URL or a system:
everything is read off the records.

## Traps

- **Every derived id is persisted wire format.** Ids come from `fhir-r4`'s
  `localResourceId` over a record's key, so changing the system a source keys
  a type in (a FHIR server's base URL included) re-keys every record of that
  type from that source.
- **A keyless record gets a fresh id on every import.** No key names it, so a
  re-import is a second record. A logical reference to it stays logical; only
  its entry's absolute `fullUrl` (a FHIR server's `Binary`) names it within
  its batch.
- **A server's `Binary` reference detaches absolute, not logical.** Detaching makes a `Binary/<id>`
  reference or attachment URL absolute, `<baseUrl>/Binary/<id>`, because
  `adopt` takes no base URL to resolve a relative one against; the Binary's
  entry must carry that same URL as its `fullUrl` for it to resolve.
- **A logical reference only resolves against its batch.** One naming a record
  the file set does not hold stays logical, by design: nothing is stored under
  the id it would derive, and the identity map resolves it against what the
  device holds.
- **Each `mapReferences` and `mapAttachmentUrls` row maps a variant to itself
  by construction, not by the type system.** A row returning a different variant would compile, and
  `fromServerRecord`'s one cast back to the resource's own type would lie.

## References

- [Source Identity Explanation](./docs/Source%20Identity%20Explanation.md) —
  why an imported resource is stored under a derived id, what detaching and
  adopting do, and the identity map's model.
- [slices/http-extraction/AGENTS.md](../AGENTS.md) — the slice this package
  belongs to.
- [slices/fhir/AGENTS.md](../../fhir/AGENTS.md) — `fhir-r4/identity`, the id
  scheme adoption stores under.
