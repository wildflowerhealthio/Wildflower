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
- `src/settings.ts` — `DicomSettings`: the one knob, `timeZone`, the IANA zone
  the acquiring equipment's clock was set to. `defaultDicomSettings` seeds it
  from `runtimeTimeZone()` — this runtime's own zone via `Intl` (`UTC` if the
  runtime reports one `effect/DateTime` cannot resolve), since a study is
  usually imported near where it was acquired.
- `src/fhir/dates.ts` — **`dicomCalendarDate`** (`DA` → the `YYYY-MM-DD` FHIR
  `date` carries) and **`dicomInstant`** (`DA` + `TM` + zone → a
  `DateTime.Utc`). The header's strings become `effect/DateTime` values here
  and nowhere later, and its module comment is the one place the reasoning
  about DICOM time lives — a `DA`/`TM` pair is wall-clock text with no offset
  (PS3.3 C.7.6.1) and FHIR's `dateTime` demands one once a time-of-day is
  present, which is why the zone is a setting. Both reject an impossible date
  (`20240230`, which `DateTime.make` would otherwise roll forward to `Mar 1`);
  `dicomInstant` is `None` for an absent or hour-only `TM`, and for a zone the
  runtime cannot resolve. `TM`'s `FFFFFF` fraction is scaled by its own width,
  so `.5` is 500ms.
- `src/fhir/to-fhir.ts` — **`toFhirResources`**: synthesizes `Patient`
  (name, identifier, birthDate, gender from M/F/O), `ServiceRequest` (emitted
  only when `AccessionNumber` is present: status completed, intent order,
  identifier = accession, code from RequestedProcedureDescription or
  StudyDescription, requester display from ReferringPhysicianName), and
  `ImagingStudy` (status available, identifier `urn:dicom:uid` /
  `urn:oid:<StudyInstanceUID>`, `started` from StudyDate+StudyTime resolved
  against `settings.timeZone` and written as an instant in UTC
  (`2024-03-15T18:30:22.000Z`) — a bare `YYYY-MM-DD` when StudyTime is absent,
  which `dateTime` permits with no offset rather than inventing a midnight —
  modality coded under DCM, one series with one instance, basedOn when
  ServiceRequest exists). Ids are deterministic via `sourceId` (FNV-1a 64-bit
  of length-prefixed components). Takes the import's `settings` and an optional
  `sourceFileId`
  (the DICOM file's own `DocumentReference` id); when given, it is stamped
  onto the `ImagingStudy` instance as a `gridfsFileId` extension
  (`{ url: 'gridfsFileId', valueString: sourceFileId }`), the link from the
  synthesized instance back to the raw source file.
- `src/decode.ts` — **`decodeDicom`**: parses the DICOM file via
  `parseDicomFile`, synthesizes FHIR resources via `toFhirResources`, adopts
  them under `DICOM_SYSTEM`. Takes `(file, settings, source)` — the picked
  file, the import's settings, and the source-file `DocumentReference`
  `perFileDecode` resolved for it (minted for a local pick, the existing one
  for a server pick). It rejects a `settings.timeZone` the runtime cannot
  resolve up front (`checkTimeZone`, a `ParseError`) rather than substituting
  one — every `started` it emits is resolved against that zone, so a guess
  would write instants hours away from what the equipment recorded. The
  `source.id` is what `toFhirResources` stamps onto the `ImagingStudy`
  instance as its `gridfsFileId` extension: the decode reads the id off the
  resolved source file and derives nothing from the bytes, so the link and the
  stored resource name the same thing by construction. One section titled
  `<Modality> <StudyDescription> · <StudyDate>` with stable keys `patient`,
  `service-request`, `imaging-study`. Notes for missing patient identity or
  absent AccessionNumber. A `dicom-parser` failure is a `ParseError`.
- `src/source-file/dicom-source-file-codec.ts` — thin config over
  `sourceFileCodec` with the DICOM coding
  (`DICOM_SYSTEM|dicom-source-file`), content type `application/dicom`. It
  exports the whole `dicomSourceFileCodec` beside the pieces, since
  `perFileDecode` mints through the codec itself.
- `src/source-file/index.ts` — barrel re-exporting codec + `DICOM_SYSTEM`.
- `src/descriptor.ts` — the `FileImporterDescriptor` for format `'dicom'`.
  Its `decode` is `perFileDecode(dicomSourceFileCodec, decodeDicom, {
subjectFor: patientSubjectOf })`: the shared helper mints each local pick's
  source file, lists it as its own "Source file" section, stamps every
  extracted resource's `meta.source` with it, and hands its reference to
  `decodeDicom`. **`patientSubjectOf`** (exported) is the one format-specific
  knob — it parses the header and returns the `Patient/<localResourceId>`
  reference the minted source file links to, or `undefined` for bytes that are
  not DICOM or a header with no patient identity. The descriptor carries no
  `buildSourceFile` of its own.
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
