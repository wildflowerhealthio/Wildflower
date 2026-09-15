# AGENTS.md — slices/importer/dicom-importer-core

The **DICOM binding** of the importer slice (core layer): DICOM tag parsing
via the `dicom` file-formats package, FHIR R4 synthesis (Patient,
ServiceRequest, ImagingStudy), byte-level `.dcm` detection, and the source
file codec that stores a DICOM file as a FHIR `DocumentReference`.

The core stays pure in the layering sense — no DOM, no `fs`, no React. A
`.dcm` file's raw bytes in, Patient / ServiceRequest / ImagingStudy out. The
decode yields one section per file when the header carries a patient identity.

## Shape

- `src/source-system.ts` — the `DICOM_SYSTEM` URI constant
  (`https://wildflowerhealth.io/fhir/sid/dicom`).
- `src/detect.ts` — DICM magic bytes at offset 128 (PS3.10 preamble + magic)
  or a `.dcm` extension fallback.
- `src/settings.ts` — empty `DicomSettings`; no user-facing knobs yet.
- `src/fhir/to-fhir.ts` — **`toFhirResources`**: synthesizes `Patient`
  (name, identifier, birthDate, gender from M/F/O), `ServiceRequest` (emitted
  only when `AccessionNumber` is present: status completed, intent order,
  identifier = accession, code from RequestedProcedureDescription or
  StudyDescription, requester display from ReferringPhysicianName), and
  `ImagingStudy` (status available, identifier `urn:dicom:uid` /
  `urn:oid:<StudyInstanceUID>`, started from StudyDate+StudyTime, modality
  coded under DCM, one series with one instance, basedOn when
  ServiceRequest exists). Ids are deterministic via `sourceId` (FNV-1a
  64-bit of length-prefixed components). Takes an optional `sourceFileId`
  (the DICOM file's own `DocumentReference` id); when given, it is stamped
  onto the `ImagingStudy` instance as a `gridfsFileId` extension
  (`{ url: 'gridfsFileId', valueString: sourceFileId }`), the link from the
  synthesized instance back to the raw source file.
- `src/decode.ts` — **`decodeDicom`**: parses the DICOM file via
  `parseDicomFile`, synthesizes FHIR resources via `toFhirResources`, adopts
  them under `DICOM_SYSTEM`. Takes `(fileBytes, fileName, settings)` — the
  `fileName` is not read for section content, only recombined with the
  bytes' SHA-256 (via the shared `sha256Base64` + `localResourceId`
  derivation `buildSourceFile` also uses) to recompute the exact id
  `buildSourceFile` will mint for this file's `DocumentReference`, which
  `toFhirResources` stamps onto the `ImagingStudy` instance. One section
  titled `<Modality> <StudyDescription> · <StudyDate>` with stable keys
  `patient`, `service-request`, `imaging-study`. Notes for missing patient
  identity or absent AccessionNumber. A `dicom-parser` failure is a
  `ParseError`.
- `src/source-file/dicom-source-file-codec.ts` — thin config over
  `sourceFileCodec` with the DICOM coding
  (`DICOM_SYSTEM|dicom-source-file`), content type `application/dicom`.
- `src/source-file/index.ts` — barrel re-exporting codec + `DICOM_SYSTEM`.
- `src/descriptor.ts` — the `FileImporterDescriptor` for format `'dicom'`.
  `buildSourceFile` parses the DICOM header to derive a Patient reference
  and sets `subject` on the archive `DocumentReference` when `PatientID`
  is present.
- `src/index.ts` — public API barrel.

## Layering

- **Depends on**: `dicom` (DICOM tag parsing), `importer-fundamentals`
  (the `FileImporterDescriptor` contract, `sourceFileCodec`), `fhir-r4`
  (resource types + identity), `kitchen-sink` (`fnv1a64`), `effect`.
- **Depended on by**: `dicom-importer-react` (settings picker),
  `importer-react` (registry entry).
- **Does not depend on**: any DOM, `fs`, or React package. Does not depend on
  `har-importer-core`, `lifelabs-pdf-importer-core`, or
  `http-extraction-fundamentals`.

## References

- [Adding a File-Format Importer How-To](../docs/Adding%20a%20File-Format%20Importer%20How-To.md)
- [importer-fundamentals AGENTS.md](../importer-fundamentals/AGENTS.md)
- [importer-react AGENTS.md](../importer-react/AGENTS.md)
