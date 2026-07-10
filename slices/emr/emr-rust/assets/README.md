# Vendored FHIR R4 assets

## `search-parameters-r4.json`

The complete **HL7 FHIR R4 (v4.0.1) `SearchParameter` conformance bundle** — the
same `search-parameters.json` published as part of the R4 specification
(`Bundle.id: "searchParams"`, `meta.lastUpdated: 2019-11-01`, 1375
`SearchParameter` resources, every `url` under `http://hl7.org/fhir/...`).

`emr-rust` embeds this file with `include_str!` and materializes it into an
app-data subdirectory at startup, then points HFS's SQLite backend at that
directory (`SqliteBackendConfig.data_dir`) so HFS registers every standard R4
search parameter and indexes it at write time. See `src/lib.rs`
(`materialize_search_parameter_specs`) and this crate's
`docs/Capability Statement.md`.

The filename **must** stay `search-parameters-r4.json`: HFS's
`SearchParameterLoader` derives the expected spec filename from the FHIR version
(`search-parameters-r4.json` for R4) and only loads a file with that exact name
from `data_dir`.

### Provenance

- **Origin:** HL7 FHIR R4 specification, `search-parameters.json`
  (canonical: <https://hl7.org/fhir/R4/search-parameters.json>).
- **Retrieved via:** the vendored copy in the `microsoft/fhir-server` repository
  (`src/Microsoft.Health.Fhir.Core/Data/R4/search-parameters.json`), because the
  canonical `hl7.org` host is not reachable from the build environment. The
  content is the unmodified HL7 base bundle — all 1375 entries carry
  `http://hl7.org/...` URLs; no vendor-specific parameters are present.
- **SHA-256:** `46a08c8ed81f837e8a869cccaeb466be79e4d01bf973ebca53c2ec4c64f1fab8`

### License

FHIR® is the registered trademark of HL7. The FHIR specification content —
including the `SearchParameter` definitions in this bundle — is published by HL7
under [Creative Commons "No Rights Reserved" (CC0)](https://www.hl7.org/fhir/license.html),
so redistributing it inside this repository imposes no additional obligations.
This file is spec data, not a Cargo dependency, so it is outside the scope of
`cargo-deny`'s license/advisory checks (which gate crate dependencies).
