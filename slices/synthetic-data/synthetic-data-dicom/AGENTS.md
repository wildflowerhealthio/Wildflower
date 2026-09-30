# AGENTS.md — slices/synthetic-data/synthetic-data-dicom

The **DICOM generator**: a real, already de-identified DICOM image
re-identified as a person in a `synthetic-data-fundamentals/story` story, and
read back through the DICOM importer onto the person's Patient from another
source. Pixels cannot be generated plausibly, so this source starts from a real
image the data set carries under its own licence and changes only its header.
No real DICOM is committed here; tests generate their files. No DOM, no `fs`,
no React.

## Shape

The root entry exports `DicomImage`:
`import { DicomImage } from 'synthetic-data-dicom'`.

- `src/dicom-image.ts` — `DicomImage.reidentify(asOf, file, reidentification)`
  reads the file with `dicom`'s `Part10`, refuses one not marked
  `PatientIdentityRemoved=YES`, and writes:
  - the patient (`PatientID`, name, sex, birth date) from the story's
    `Person`;
  - the study, series, acquisition and content dates on the `studyDay`, at a
    time of day hashed from the person and image (`AcquisitionDateTime` to
    match, when present); every other top-level date or time, and
    `PatientAge`, removed;
  - Study, Series and SOP Instance UIDs, and every other top-level instance
    UID, minted under `UID_ROOT` (`2.25.<uuid-decimal>`) from the person's and
    image's keys; `MediaStorageSOPInstanceUID` follows;
  - private elements and data set group lengths removed, `ImageType`
    `DERIVED\PRIMARY`, `DeidentificationMethod` noting the synthetic identity,
    `LongitudinalTemporalInformationModified` `MODIFIED`.

  Pixel Data and every other element are copied byte for byte.
  `DicomImage.importWithSubject(file, fileName, subject)` runs
  `dicomImporter.decode` (the equipment clock read in `EQUIPMENT_TIME_ZONE`),
  drops its `Patient` and files the `ImagingStudy`, `ServiceRequest` and
  source-file `DocumentReference` on `subject` (`fhir-r4/resources`'
  `withSubject`).

`synthetic-data-dicom/test-helpers` (`src/test-helpers.ts`) holds
`deidentifiedFileArbitrary`: a `writeDicom` file with a de-identified export's
elements spliced in (`dicom/test-helpers`' `withElementsSpliced`).

## Layering

Depends on `synthetic-data-fundamentals` (`Person` and `StoryDay` from
`/story`, `Seeding` from `/seeding`), `dicom` (`Part10`, `DataElement`),
`dicom-importer-core` (`dicomImporter`) and `fhir-r4` (`withSubject`, the
resource and `Reference` types). The tests also use `dicom-parser` and
`dicom/test-helpers`, as dev dependencies only. Never imports a `-react`,
`-node` or `-tauri` package.

## Rules

- **Only a de-identified source.** A file not marked
  `PatientIdentityRemoved=YES` is refused, so a real patient's image is never
  relabelled by mistake.
- **Only top-level elements are rewritten.** A private element, date or
  instance UID nested in a sequence keeps the source's value, so a source is
  one whose de-identification profile cleans or removes those.
- **Written values stay portable.** A value its VR cannot hold, or that is not
  printable ASCII, fails with `UnencodableValue` rather than being truncated.

## Traps

- **Only Explicit VR Little Endian data sets** (and the encapsulated syntaxes)
  are read; `Part10` rejects Implicit VR, Big Endian and Deflated files with a
  reason.
- **The tags written here are this generator's own list** (`Tag` in
  `dicom-image.ts`), as numbers for `Part10`; `dicom`'s `DicomHeader` keys the
  tags it reads as `dicom-parser` strings.
- **`package.json` `exports` and `vite.config.ts` `pack.entry` must stay in
  sync** (`index`, `test-helpers`).

## References

- [slices/synthetic-data/AGENTS.md](../AGENTS.md) — the slice and its packages.
- [file-formats AGENTS.md](../../file-formats/AGENTS.md) — `dicom`, `Part10`
  and the DICOM test fixtures.
