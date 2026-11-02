# AGENTS.md — slices/http-extraction/fhir-r4-adoption

The **FHIR R4 side of extraction**: how a resource decoded from a source
becomes the device's own. A resource is keyed by (system, type, source id) —
the system being FHIR's `Identifier.system`, the one its source id belongs to
— under a local id derived from that key, its references rewritten to land on their targets'
derived ids, and comes out with an id whether or not the source gave it one.
It sits above `fhir-r4` (the resource schemas and `localResourceId`) and
`http-extraction-fundamentals` (the response-kind vocabulary), which stays
FHIR-free.

## Shape

- `src/decoded-id.ts` — `DecodedId`, the source id a decoded resource is
  adopted under: `FoundInSource` the id the source gave it, or
  `GeneratedFromContent` a digest of its content when it gave none (FNV-1a 64
  over the system its id would have been in and its FHIR JSON as
  `FhirResourceSchema` encodes it, without `meta`). `DecodedId.of(system,
  resource)` picks one; `CONTENT_DIGEST_SYSTEM` is the system a digest id is
  in.
- `src/adopt-resource.ts` — `withSourceId(family)` pairs a decoded record
  with its key (`{ system, sourceId, resource }`, the id from `DecodedId.of`
  in `systemFor(family, Type)`); the LifeLabs and DICOM decoders call it for
  each record of their `FromSource` sections. `adoptUnderKey(family)` adopts
  a record under the key it is handed, its references keyed in `family`;
  `importer-core`'s import stage calls it for each record of a decoded
  `FromSource` section. `adoptResource(family)` is the two together, which
  `adoptUnderRecognizedRoot` runs: the derived id, the
  source id as `identifier[0]`, and each
  reference whose literal relativises (`SystemFamily.relativise`) to a
  `Type/id` rewritten into `systemFor(family, Type)` through the per-type
  reference table (`mapReferences`); any other reference keeps its original
  spelling. `originalIdOf(system, resource)` reads the source's id back off
  an adopted resource; `adoptedReferenceOf(system, Type, id)` spells a
  reference to a resource a source's import adopts, for a resource written
  outside that source. Both take the system adoption keys the type in
  (`systemFor(family, Type)`), never a FHIR base URL.
- `src/adopt-under-recognized-root.ts` — `adoptUnderRecognizedRoot(kind)`,
  which takes a `HttpResponseKind<FhirResource>` to a
  `HttpResponseKind<FhirResourceWithId>` whose `parse` adopts every resource
  under the identity the kind's own `tryRecognize` mints for the response URL,
  failing with a `ParseError` when the URL is not recognized or mints no
  source. Each per-source package maps its kind list through it once, at
  module load.

## Layering

Pure: no DOM, no `fs`, no React. Depends on `fhir-r4`,
`http-extraction-fundamentals`, `kitchen-sink` and `effect`. The per-source
packages in this slice, the file importers (`dicom-importer-core`,
`lifelabs-pdf-importer-core`), `importer-core`'s import stage and the
synthetic-data generators build on it. It must
never import from `slices/importer`, and `http-extraction-fundamentals` must
never import it: `SystemFamily` is defined there, and this package
re-exports it for the file importers.

## Traps

- **Every derived id is persisted wire format.** Ids come from `fhir-r4`'s
  `localResourceId` over (system, type, source id), so changing a source's
  system family re-keys every resource in it, and changing what `DecodedId.of` digests
  re-keys every resource with no id of its own.
- **A resource that does not encode is a defect.** `DecodedId.of` encodes
  through `FhirResourceSchema`; a kind whose decode lets through what the
  schema's encode refuses dies there, rather than minting an id from a value
  that has no FHIR JSON.
- **Each `mapReferences` row maps a variant to itself by construction, not by
  the type system.** `adoptResource` returns `FhirResourceWithId`, the whole
  union; a row returning a different variant would compile.
- **Never adopt a locally minted resource.** `web-trace-core`'s traces already
  carry their derived id; adopting one would hash a hash.

## References

- [Source Identity Explanation](./docs/Source%20Identity%20Explanation.md) —
  why an imported resource is keyed under a derived id, and what adoption
  rewrites.
- [slices/http-extraction/AGENTS.md](../AGENTS.md) — the slice this package
  belongs to.
- [slices/fhir/AGENTS.md](../../fhir/AGENTS.md) — `fhir-r4/identity`, the id
  scheme adoption keys under.
