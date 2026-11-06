# AGENTS.md — slices/importer/dicom-importer-core

The **DICOM binding** of the importer slice (core layer): DICOM tag parsing
via the `dicom` file-formats package, FHIR R4 synthesis (Patient,
ServiceRequest, ImagingStudy), byte-level `.dcm` detection, and the
source-file coding that stores a DICOM file as a FHIR `DocumentReference`.

The core stays pure in the layering sense — no DOM, no `fs`, no React. A
pick of `.dcm` bytes in, Patient / ServiceRequest / ImagingStudy out. What
decodes together is a **study**, not a file: the decode groups a pick by
`StudyInstanceUID` (and patient) and yields one section per study, each
carrying the one `ImagingStudy` its files make up.

## Shape

- `src/source-system.ts` — **`DICOM_SYSTEM`**
  (`https://wildflowerhealth.io/fhir/sid/dicom`), the coding system a DICOM
  source file is stored under, and **`DicomIdentifierSystem`**, the systems
  records are keyed in when the file names no issuer URI: `PatientId`
  (`…/dicom/patient-id`), `AccessionNumber` (`…/dicom/accession-number`),
  `PatientNameBirthDate` (`…/dicom/patient-name-birth-date`), all
  Wildflower-minted and meaning "a DICOM number of this kind whose issuer the
  file does not state", and `StudyInstanceUid` (`urn:dicom:uid`, FHIR's own);
  and **`DICOM_PRACTITIONER_NAME_SYSTEM`** (`<DICOM_SYSTEM>/practitioner-name`),
  the system a referring physician known only by name is keyed in. All
  persisted wire format.
- `src/fhir/issuer.ts` — the HL7 v2 HD-to-URI rule the v2-to-FHIR mapping
  uses. **`universalSystemOf`** spells a Universal Entity ID as a system: `ISO`
  as `urn:oid:<id>` (a well-formed OID), `UUID` as `urn:uuid:<id>` (lower
  case), `URI` as itself when `Schema.URL` accepts it; `None` for any other
  type or a malformed value. **`issuedIdentifierOf`** keys a number under that
  system, else under the caller's fallback, with the local namespace (else an
  unresolved Universal Entity ID, as written) as `assigner.display` — so the
  decode is total whatever the issuer states. **`unresolvedUniversalIssuerOf`**
  names a stated Universal Entity ID that resolves to no URI, for the decode's
  note.
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
  `dicomInstant` is `None` for an absent or hour-only `TM`, for one naming no
  clock time (`1275`, which would otherwise roll forward to `13:15`), and for a
  zone the runtime cannot resolve. `TM`'s `FFFFFF` fraction is read by its own
  width, so `.5` is 500ms, and truncated to the millisecond.
- `src/fhir/to-fhir.ts` — **`toFhirResources`**: synthesizes `Patient`
  (name, identifier, birthDate, gender from M/F/O), `ServiceRequest` (emitted
  only when `AccessionNumber` is present: status completed, intent order,
  identifier = the accession typed `ACSN` (v2-0203), code from RequestedProcedureDescription or
  StudyDescription, requester from ReferringPhysicianName:
  `Practitioner.tryReferenceWireFromName` in `DICOM_PRACTITIONER_NAME_SYSTEM`
  (`<DICOM_SYSTEM>/practitioner-name`) of the physician's given names, then
  family name (`Smith^Jane` is `Jane Smith`, as a prescription prints it;
  middle name, prefix and suffix left out), so the import stage implies one
  Practitioner per name, a referent the reviewer can link to the same
  provider named elsewhere, and no requester for a PN with neither; the Patient's `name` keeps the PN `text`,
  family first), and
  `ImagingStudy` (status available, identifier `urn:dicom:uid` /
  `urn:oid:<StudyInstanceUID>`, `started` from StudyDate+StudyTime resolved
  against `settings.timeZone` and written as an instant in UTC
  (`2024-03-15T18:30:22.000Z`) — a bare `YYYY-MM-DD` when StudyTime is absent,
  which `dateTime` permits with no offset rather than inventing a midnight —
  modality the distinct set across the study's series, basedOn when
  ServiceRequest exists; `started` reads the earliest header through an
  `Order` that sorts a missing `StudyDate` **last**, so a file stating none
  never claims the study's instant). It takes a **whole file set** — a
  `StudyInstance`, a parsed header, per file — so the study's `series` are its
  distinct `SeriesInstanceUID`s ordered by `SeriesNumber`, its `instance`s are
  its files ordered by `InstanceNumber`, `numberOfSeries`/`numberOfInstances`
  are the real counts, and `started` is the earliest StudyDate+Time any file
  states. The synthesis names no file: which source file stores an instance is
  the import's to say (`addGridfsFileIds`). Each record's key, `identifier[0]`,
  is the identifier the file carries for it, as FHIR R4's DICOM mapping for
  `ImagingStudy.identifier` reads them: the `Patient` its Patient ID
  (0010,0020) under the URI Issuer of Patient ID Qualifiers Sequence
  (0010,0024) names, else `DicomIdentifierSystem.PatientId`, with Issuer of
  Patient ID (0010,0021) as `assigner.display`; a patient with no Patient ID
  its `<PN text>, <YYYY-MM-DD>` (the name alone without a valid birth date) in
  `PatientNameBirthDate`, and none at all with no name either
  (**`patientKeyOf`**); the `ServiceRequest` its Accession Number under the
  URI Issuer of Accession Number Sequence (0008,0051) names, else
  `DicomIdentifierSystem.AccessionNumber`, its Local Namespace Entity ID as
  `assigner.display` — read off the first file in study order stating an
  accession; the `ImagingStudy` its Study Instance UID
  (**`imagingStudyKeyOf`**). `subject` and `basedOn` name the others by those
  keys (`DetachedResource.logicalReferenceWire`, system and value only). The
  same study picked twice, or from two discs, keys the same records.
  **Every ordering is a function of the
  headers** (`compareInstances`: `InstanceNumber`, `SOPInstanceUID`, then
  `SOPClassUID`; two instances it leaves tied are alike in every field), so
  the same study picked in any order imports to identical resources. Files that disagree on `AccessionNumber` are not
  merged: the first in study order builds the one `ServiceRequest` and
  `accessionNumbers` is what the decode reports the disagreement from.
- `src/decode.ts` — what makes a set of picked files one import, and how that set
  decodes. **`studyKey(header)`** is `StudyInstanceUID` **plus** the
  `patientKeyOf` key: a patient the files disagree on splits the set rather
  than filing one patient's images in another's record. Both sets still key
  one `ImagingStudy`, the UID, and **`withSharedStudyNotes`**, run over the
  format's whole decode, adds **`SHARED_STUDY_NOTE`** to each set whose
  `ImagingStudy` key another set of the batch carries too.
  **`studyGroupKey`** is the `groupBy` the importer states: it parses the picked file's
  header (headers only, cheap) and returns `studyKey(header)`, or a `Left` —
  a file `dicom-parser` rejects states no study to belong to, and folding it
  into a neighbour would hide which file failed, so the decode constructor
  reports it as its own `unreadableFiles` row.
  **`decodeStudy`** takes one study's picked files and **parses each header
  itself**. A header that parsed in `studyGroupKey` parses
  again; that double parse is the deliberate price of a decode constructor with
  no parsed-value passthrough. It yields one `DecodedFileSet.Type`: one section
  of FHIR records, each written detached and keyed by the identifier its files
  carry (`fhir-r4-adoption`'s `DetachedResource`), each record's local key fixed by its
  type (`patient`, `service-request`, `imaging-study`), for the import stage to adopt
  before it runs
  `linkToPatientAndStudy` and `addGridfsFileIds`, and its `pickedFiles`, each picked file paired with its SOP Instance UID
  (**`sopInstanceIdentifier`**: `{ system: 'urn:ietf:rfc:3986', value:
  'urn:oid:<SOPInstanceUID>' }`, FHIR's OID convention), which the import
  stage writes as its source file's `masterIdentifier`. Titled
  `<Modality> <StudyDescription> · <StudyDate>` off the study's representative
  header, with stable local keys `patient`, `service-request`, `imaging-study`,
  fixed _within one study_ and namespaced by the import stage outside it. Notes for missing patient
  identity, a stated issuer of the Patient ID or the Accession Number that
  names no URI (its number keyed under the fallback), an absent
  `AccessionNumber`, one the files disagree on, and — for a
  study of more than one file — what each file contributed.
  It rejects a `settings.timeZone` the runtime cannot resolve
  (`checkTimeZone` from `kitchen-sink`, a `ParseError`) rather than
  substituting one — every `started` it emits is resolved against that zone,
  so a guess would write instants hours away from what the equipment
  recorded; one setting for every study the format claimed, so an
  unresolvable zone fails every set, and with it every file. A study that fails to decode becomes one
  `unreadableFiles` row per file of it, leaving the other studies reviewable.
  **`linkToPatientAndStudy`**, the importer's `linkSourceFile`, links each
  source file to the study's own records:
  `subject` = the synthesized `Patient`, `context.related` = the study's
  `ImagingStudy` — `subject` alone cannot separate two studies of one patient,
  and `related` is what tells a reader of the server list which study a source file
  was read into. It changes no `id`: the row listed for review and the reference
  `meta.source` names are both read back off what it returns. The study-level
  resources' `meta.source` names the set's smallest source file id; per-file
  provenance is the per-instance `gridfsFileId` (`dicom-importer.ts`).
- `src/source-file.ts` — the `/source-file` subpath: a narrowing of
  `source-system.ts` to just the coding constants (`DICOM_SYSTEM`,
  `DICOM_SOURCE_FILE_CODE`, `DICOM_SOURCE_FILE_CONTENT_TYPE`), so a reader
  building the cross-format search token imports one narrow thing rather than
  this package's whole surface. The FHIR encoding is not written here —
  `dicom-importer.ts` states those constants as its `sourceFileFormat`.
- `src/dicom-importer.ts` — **`dicomImporter`**, the `FileImporter.Type`
  literal for format `'dicom'`: the DICOM coding
  (`DICOM_SYSTEM|dicom-source-file`), content type `application/dicom`,
  `detectDicom`, the default settings, a `DecodeFunction.make` over
  `studyGroupKey` and `decodeStudy` with `withSharedStudyNotes` over its
  result, and `linkToPatientAndStudy` and
  `addGridfsFileIds` as its `linkSourceFile` and `linkToSourceFiles`.
  **`addGridfsFileIds`** sets each `ImagingStudy` instance's `gridfsFileId`
  extension (**`GRIDFS_FILE_ID_EXTENSION_URL`**, a `valueString` because the
  OHIF viewer's FHIR extension reads it to fetch the file) to the id of the
  source file whose `masterIdentifier` is the instance's `uid` as
  `sopInstanceIdentifier` spells it — the smallest id when two files share a
  UID, looked up in a map of the set's source files built once per study —
  replacing any `gridfsFileId` already there and keeping other extensions; an
  instance no source file matches fails with `FileImporter.SourceFileNotFound`,
  which the import stage reports as the study's files being unreadable. It
  reads only FHIR, no header. Per instance, so a study spanning files keeps
  per-file provenance that one `meta.source` could not. The one format so far
  that states a `groupBy`: decoding a study's files independently would yield
  N one-instance `ImagingStudy`s sharing an id, each overwriting the last —
  D3's known limit, which this binding closes. `sourceFileFormat` is spelled
  once, so the constants a reader of the server list recognizes a source file
  by are the ones the import stage mints its source files under.
- `src/index.ts` — public API barrel.

## Layering

- **Depends on**: `dicom` (DICOM tag parsing), `importer-fundamentals`
  (`DecodeFunction.make`, the `FileImporter` contract, the `PickedFile`
  vocabulary, `DecodedFileSet`), `fhir-r4` (resource types
  and identity), `fhir-r4-adoption` (`DetachedResource`), `kitchen-sink`
  (`checkTimeZone`), `effect`.
- **Depended on by**: `dicom-importer-react` (settings picker),
  `importer-react` (registry entry).
- **Does not depend on**: any DOM, `fs`, or React package. Does not depend on
  `har-importer-core`, `lifelabs-pdf-importer-core`, or
  `http-extraction-fundamentals`.

## Traps

- **Every key is persisted wire format.** The ids records are stored under
  derive from their keys, so changing a `DicomIdentifierSystem` value, the HD
  to URI spelling, or the name-and-birth-date value re-keys every DICOM record
  of that type already imported.
- **A local issuer is not part of the key.** One Patient ID under two local
  Issuers of Patient ID (0010,0021), with no universal issuer, keys one
  `Patient` in `DicomIdentifierSystem.PatientId`: a certain match, accepted.
  Likewise two patients' files stating one Accession Number under one issuer
  are one `ServiceRequest`, and two stating one Study Instance UID one
  `ImagingStudy` — `studyKey` still splits them into two sets, each noted.

## References

- [Adding a File-Format Importer How-To](../docs/Adding%20a%20File-Format%20Importer%20How-To.md)
- [importer-fundamentals AGENTS.md](../importer-fundamentals/AGENTS.md)
- [importer-react AGENTS.md](../../../slices/importer/importer-react/AGENTS.md)
