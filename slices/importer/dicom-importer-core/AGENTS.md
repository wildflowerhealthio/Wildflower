# AGENTS.md — slices/importer/dicom-importer-core

The **DICOM binding** of the importer slice (core layer): byte-level `.dcm`
detection, the archive codec that stores a DICOM file as a FHIR
`DocumentReference`, and the importer descriptor. No DICOM tag parsing — D3
fills that in.

The core stays pure in the layering sense — no DOM, no `fs`, no React. A
`.dcm` file's raw bytes in, stored as an archive, zero extracted resources out
(one note says the contents are not read yet). The decode yields zero sections
so the review screen is honest about what confirm will do.

## Shape

- `src/source-system.ts` — the `DICOM_SYSTEM` URI constant
  (`https://wildflowerhealth.io/fhir/sid/dicom`).
- `src/detect.ts` — DICM magic bytes at offset 128 (PS3.10 preamble + magic)
  or a `.dcm` extension fallback.
- `src/settings.ts` — empty `DicomSettings`; no user-facing knobs yet.
- `src/decode.ts` — returns zero sections and one diagnostic note; D3 adds
  tag parsing.
- `src/archive/dicom-archive-codec.ts` — thin config over `sourceArchiveCodec`
  with the DICOM coding (`DICOM_SYSTEM|dicom-archive`), content type
  `application/dicom`.
- `src/archive/index.ts` — barrel re-exporting codec + `DICOM_SYSTEM`.
- `src/descriptor.ts` — the `FileImporterDescriptor` for format `'dicom'`.
- `src/index.ts` — public API barrel.

## Layering

- **Depends on**: `importer-fundamentals` (the `FileImporterDescriptor`
  contract, `sourceArchiveCodec`), `fhir-r4` (resource types), `kitchen-sink`,
  `effect`.
- **Depended on by**: `dicom-importer-react` (settings picker),
  `importer-react` (registry entry).
- **Does not depend on**: any DOM, `fs`, or React package. Does not depend on
  `har-importer-core`, `lifelabs-pdf-importer-core`, or
  `http-extraction-fundamentals`.

## References

- [Adding a File-Format Importer How-To](../docs/Adding%20a%20File-Format%20Importer%20How-To.md)
- [importer-fundamentals AGENTS.md](../importer-fundamentals/AGENTS.md)
- [importer-react AGENTS.md](../importer-react/AGENTS.md)
