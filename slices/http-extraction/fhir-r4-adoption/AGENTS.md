# AGENTS.md — slices/http-extraction/fhir-r4-adoption

The **FHIR R4 side of extraction**: how a resource decoded from a source
becomes the device's own. A resource is adopted under its source's identity —
keyed under a local id derived from the source's system, its type and the id
it is adopted under, its references rewritten to land on their targets'
derived ids — and comes out with an id whether or not the source gave it one.
It sits above `fhir-r4` (the resource schemas and `localResourceId`) and
`http-extraction-fundamentals` (the response-kind vocabulary), which stays
FHIR-free.

## Shape

- `src/decoded-id.ts` — `DecodedId`, the id a decoded resource is adopted
  under: `FoundInSource` the id the source gave it, or `GeneratedFromContent` a
  digest of its content when it gave none (FNV-1a 64 over its FHIR JSON as
  `FhirResourceSchema` encodes it, without `meta`). `DecodedId.of(resource)`
  picks one.
- `src/id-space.ts` — `IdSpace`, the space a decoded record's id belongs to:
  `FhirServer` (a server's root), `SourceSystem` (a Wildflower-minted coding
  system), `ContentDigest` (a digest id `within` one of those) or `SourceFile`
  (a picked file's own `DocumentReference`). Its getters state the hash
  domain, whether the source assigned the id, the `${base}/` self-reference
  prefix, and the URI naming the space (`<base>/<Type>` for a server).
- `src/adopt-resource.ts` — `adoptInIdSpace(idSpace)`, the per-resource
  rewrite of a record and its explicit source id: the derived id, the source
  identifier a source-assigned id records as `identifier[0]` (a
  `ContentDigest` or `SourceFile` one records none), and the per-type
  reference rewrite. `adoptResource(source)` is the decode-time wrapper: it
  takes the id space from a `SourceIdentity` (`{ system, baseUrl? }`) and the
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
  `localResourceId`; a content digest is its hash input for a resource with no
  id of its own, so changing what `DecodedId.of` digests re-keys every such
  resource already stored.
- **A resource that does not encode is a defect.** `DecodedId.of` encodes
  through `FhirResourceSchema`; a kind whose decode lets through what the
  schema's encode refuses dies there, rather than minting an id from a value
  that has no FHIR JSON.
- **Each `adoptX` maps a variant to itself by construction, not by the type
  system.** `adoptInIdSpace` returns `FhirResourceWithId`, the whole union; an
  `adoptX` returning a different variant would compile.
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
