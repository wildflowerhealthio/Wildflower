# AGENTS.md — slices/http-extraction/fhir-r4-adoption

The **FHIR R4 side of extraction**: a resource a source decoded, detached
from that source, and a detached resource adopted into the device's store.
A detached resource has no id (FHIR's logical id only means something on the
server that assigned it), is keyed by its first identifier — FHIR's
`Identifier.system` and `value` — and names every other decoded record by a
logical reference. Adopting one stores it under a local id derived from its
key and resolves each logical reference to a record of its batch to a literal
one, as a FHIR server resolves a conditional reference against a transaction
bundle. It sits above
`fhir-r4` (the resource schemas and `localResourceId`) and
`http-extraction-fundamentals` (the response-kind vocabulary and
`SystemFamily`), which stays FHIR-free.

## Shape

- `src/detached-resource.ts` — `DetachedResource.Type`, `FhirResource`
  narrowed to `id: null`; `keyOf` (the qualified `identifier[0]`, `None` for a
  keyless record, a `Binary` always), `keyedIdOf` (the id a keyed record is
  stored under, for a review title), `storedReferenceOf` (the one spelling of
  a keyed record's stored reference, `<Type>/<localResourceId(…)>`),
  `storedReferencesOf` (the stored reference of every keyed record of a
  batch), and `hasIdentifier` (whether the record's type has an `identifier`
  element: every `fhir-r4` schema with one defaults it to `[]`, so the
  decoded record carries the property exactly then).
- `src/adopt-resource.ts` — the per-type reference table (`mapReferences`,
  the one place a resource's references are walked) and the two directions
  through it. `detach(family)` drops a resource's `id`, prepends
  `{ system: SystemFamily.systemFor(family, Type), value: id }` as
  `identifier[0]` when it had one and the type has an `identifier` element,
  and turns each reference whose literal relativises
  (`SystemFamily.relativise`) to a `Type/id` of an R4 resource type
  (`fhir-r4`'s `ResourceType`) into the logical reference to its target by
  key, replacing any identifier the source had put on it; any other reference
  (a non-R4 token like carebook's `PrescriptionOrder` included) keeps its
  spelling and identifier. `adopt({ storedReferences, mintId })` stores a
  keyed record under `localResourceId(key.system, Type, key.value)` and a
  keyless one under `mintId()` (`randomResourceId`, a UUID, outside tests),
  and resolves a logical reference to its target's stored reference when that
  is in `storedReferences`, keeping `type` and `identifier`; one naming a
  record the batch does not hold stays logical, for the importer's identity
  map. `adoptedReferenceOf(system, Type, id)` is the literal reference the
  import stores the record with that key under, for a resource written
  outside that source; `originalIdOf(system, resource)` reads the value of a
  resource's identifier in `system`.

## Layering

Pure: no DOM, no `fs`, no React. Depends on `fhir-r4`,
`http-extraction-fundamentals` and `effect`. The file importers
(`dicom-importer-core`, `lifelabs-pdf-importer-core`) and `har-importer-core`
detach with it, `importer-fundamentals`' `DecodedFileSet.adopt` adopts with it,
and the synthetic-data generators spell references with it. It must never
import from `slices/importer`, and `http-extraction-fundamentals` must never
import it: `SystemFamily` is defined there, and this package re-exports it for
the file importers. Nothing on the import side takes a `SystemFamily`: `adopt`
reads everything off the records.

## Traps

- **Every derived id is persisted wire format.** Ids come from `fhir-r4`'s
  `localResourceId` over a record's key, so changing the system a family gives
  a type re-keys every record of that type from that source.
- **A keyless record gets a fresh id on every import.** Nothing names it, so a
  re-import is a second record, and a reference to it stays logical.
- **A logical reference only resolves against its batch.** One naming a record
  the file set does not hold stays logical, by design: nothing is stored under
  the id it would derive, and the identity map resolves it against what the
  device holds.
- **Each `mapReferences` row maps a variant to itself by construction, not by
  the type system.** A row returning a different variant would compile.

## References

- [Source Identity Explanation](./docs/Source%20Identity%20Explanation.md) —
  why an imported resource is stored under a derived id, what detaching and
  adopting do, and the identity map's model.
- [slices/http-extraction/AGENTS.md](../AGENTS.md) — the slice this package
  belongs to.
- [slices/fhir/AGENTS.md](../../fhir/AGENTS.md) — `fhir-r4/identity`, the id
  scheme adoption stores under.
