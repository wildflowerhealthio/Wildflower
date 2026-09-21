# AGENTS.md — slices/importer/dicom-importer-core

The **DICOM binding** of the importer slice (core layer): DICOM tag parsing
via the `dicom` file-formats package, FHIR R4 synthesis (Patient,
ServiceRequest, ImagingStudy), byte-level `.dcm` detection, and the
source-file coding that stores a DICOM file as a FHIR `DocumentReference`.

The core stays pure in the layering sense — no DOM, no `fs`, no React. A
pick of `.dcm` bytes in, Patient / ServiceRequest / ImagingStudy out. The unit
is a **study**, not a file: the decode partitions a pick by
`StudyInstanceUID` (and patient) and yields one section per study, each
carrying the one `ImagingStudy` its files make up.

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
- `src/study-unit.ts` — **`partition`**: parses every pick's header (headers
  only, cheap) and groups them into studies. The key is `StudyInstanceUID`
  **plus** the patient identity `patientOriginalId` derives: a `PatientID` the
  files disagree on splits the unit rather than filing one patient's images in
  another's record. A file `dicom-parser` rejects is its own `unparsed` row —
  it states no study to belong to, and folding it into a neighbour would hide
  which file failed.
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
  modality the distinct set across the study's series, basedOn when
  ServiceRequest exists). It takes a **unit** — a `StudyInstance` per file,
  each a parsed header plus the id of the archive storing it — so the study's
  `series` are its distinct `SeriesInstanceUID`s ordered by `SeriesNumber`,
  its `instance`s are its files ordered by `InstanceNumber`,
  `numberOfSeries`/`numberOfInstances` are the real counts, and `started` is
  the earliest StudyDate+Time any file states. Each instance carries its own
  file's archive id as a `gridfsFileId` extension
  (`{ url: 'gridfsFileId', valueString: sourceFileId }`) — per instance, so a
  study spanning files keeps per-file provenance that one `meta.source` could
  not. Ids are deterministic via `sourceId` (FNV-1a 64-bit of length-prefixed
  components), and **every ordering is a function of the files alone**
  (`compareInstances`), so the same study picked in any order synthesizes
  identical resources. Files that disagree on `AccessionNumber` are not
  merged: the first in study order builds the one `ServiceRequest` and
  `accessionNumbers` is what the decode reports the disagreement from.
- `src/decode.ts` — **`decodeStudy`**: one study's files in, one section of
  adopted, labeled FHIR resources out. Titled
  `<Modality> <StudyDescription> · <StudyDate>` off the study's representative
  header, with stable keys `patient`, `service-request`, `imaging-study` —
  the same keys the per-file decode used before a study spanned files, so a
  review's exclusions survive both a settings re-decode and that change. They
  are fixed _within one unit_; `dicom-decode.ts` namespaces them by the pick
  that opened the unit. Notes for missing patient identity, an absent
  `AccessionNumber`, one the files disagree on, and — for a study of more than
  one file — what each file contributed.
- `src/dicom-decode.ts` — **`decodeDicomBatch`**, the format's whole
  `DecodeFunction`: `partition` the pick, then per study resolve each file's
  source file, run `decodeStudy`, namespace the unit's keys, stamp
  `meta.source`, and mint one archive per file. This is the _second_
  constructor of `importer-fundamentals`' decode contract and the reason
  `PerFileDecodeFunction` could not be used: decoding a study's files
  independently yields N one-instance `ImagingStudy`s sharing an id, each
  overwriting the last — D3's known limit, which this ticket closes. What it
  shares with the per-file constructor (resolving a pick to its reference,
  listing the minted archives as their own section) is
  `importer-fundamentals`' `SourceFileMint`; the rest is DICOM's.
  It rejects a `settings.timeZone` the runtime cannot resolve up front
  (`checkTimeZone` from `kitchen-sink`, a `ParseError`) rather than
  substituting one — every `started` it emits is resolved against that zone,
  so a guess would write instants hours away from what the equipment
  recorded; one setting for the whole pick, so an unresolvable zone fails
  every file at once. A study that fails to decode becomes one
  `unreadableFiles` row per file of it, leaving the other studies reviewable.
  Each minted archive is filed with `subject` = the synthesized `Patient` and
  `context.related` = the study's `ImagingStudy`: `subject` alone cannot
  separate two studies of one patient, and `context.related` is what lets the
  server list show a study's archives as one study and re-pick them as one
  unit. The study-level resources' `meta.source` names the archive of the
  study's _representative_ instance — the first instance of its first series,
  by the study's own order rather than the pick's, so the stamp is identical
  however the files were picked.
- `src/source-file.ts` — the `/source-file` subpath: a narrowing of
  `source-system.ts` to just the coding constants (`DICOM_SYSTEM`,
  `DICOM_SOURCE_FILE_CODE`, `DICOM_SOURCE_FILE_CONTENT_TYPE`), so a reader
  building the cross-format search token imports one narrow thing rather than
  this package's whole surface. The FHIR encoding is not written here —
  `dicom-importer.ts` passes those constants to `FileImporter.make` as its
  `sourceFileFormat`.
- `src/dicom-importer.ts` — **`dicomImporter`**, the `FileImporter.make` call
  for format `'dicom'`: the DICOM coding (`DICOM_SYSTEM|dicom-source-file`),
  content type `application/dicom`, `detectDicom`, the default settings, and
  `decodeDicomBatch` as its whole `decode`. The factory's one job here is
  discharging the `SourceFileCodec.FormatContext` that decode is written
  against, so the coding constants the importer reads its `categoryToken` and
  `isSourceFile` out of are by construction the ones its archives are minted
  under.
- `src/index.ts` — public API barrel.

## Layering

- **Depends on**: `dicom` (DICOM tag parsing), `importer-fundamentals`
  (the `DecodeFunction` contract, the `SourceFileMint` half both decode
  constructors share, and the `FileImporter.make` factory), `fhir-r4`
  (resource types + identity), `kitchen-sink` (`fnv1a64`, `checkTimeZone`),
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
