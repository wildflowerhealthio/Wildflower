# AGENTS.md — slices/http-extraction/fhir-r4-adoption

The **FHIR R4 side of extraction**: how a resource decoded from a source
becomes the device's own. A resource is keyed by (id space, type, source id) —
the id space being the system its source id belongs to — under a local id
derived from that key, its references rewritten to land on their targets'
derived ids, and comes out with an id whether or not the source gave it one.
It sits above `fhir-r4` (the resource schemas and `localResourceId`) and
`http-extraction-fundamentals` (the response-kind vocabulary), which stays
FHIR-free.

## Shape

- `src/decoded-id.ts` — `DecodedId`, the source id a decoded resource is
  adopted under: `FoundInSource` the id the source gave it, or
  `GeneratedFromContent` a digest of its content when it gave none (FNV-1a 64
  over its source's id space and its FHIR JSON as `FhirResourceSchema` encodes
  it, without `meta`). `DecodedId.of(scope, resource)` picks one.
- `src/id-space.ts` — `IdSpace`, a branded string: the system a record's
  source id belongs to. `inFhirServer(base)` gives `<base>/<Type>` per type,
  `inSystem(system)` one system for every type (a portal, a file format), and
  `CONTENT_DIGEST` is the space of a record its source gave no id.
  `IdSpace.OfType` is a source's rule: the id space of each type.
- `src/adopt-resource.ts` — `adoptInIdSpace(idSpaceOf)`, the per-resource
  rewrite of a record and its key: the derived id, `{ system: idSpace, value:
  sourceId }` as `identifier[0]`, and each relative `Type/id` reference
  rewritten into `idSpaceOf(Type)` through the per-type reference table
  (`mapReferences`). `adoptResource(source)` is the decode-time wrapper: it
  takes the id spaces from a `SourceIdentity` (`{ system, baseUrl? }`),
  relativises a FHIR server's absolute references to itself, and takes the
  source id from `DecodedId.of`. `originalIdOf` reads the source's id back off
  an adopted resource; `adoptedReferenceOf` spells a reference to a resource a
  source's import adopts, for a resource written outside that source.
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
`lifelabs-pdf-importer-core`) and the synthetic-data generators build on it. It must
never import from `slices/importer`, and `http-extraction-fundamentals` must
never import it: `RecognizedUrlData.source` is `SourceIdentity`'s shape,
spelled structurally there.

## Traps

- **Every derived id is persisted wire format.** Ids come from `fhir-r4`'s
  `localResourceId` over (id space, type, source id), so changing an id space
  re-keys every resource in it, and changing what `DecodedId.of` digests
  re-keys every resource with no id of its own.
- **A resource that does not encode is a defect.** `DecodedId.of` encodes
  through `FhirResourceSchema`; a kind whose decode lets through what the
  schema's encode refuses dies there, rather than minting an id from a value
  that has no FHIR JSON.
- **Each `mapReferences` row maps a variant to itself by construction, not by
  the type system.** `adoptInIdSpace` returns `FhirResourceWithId`, the whole
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
