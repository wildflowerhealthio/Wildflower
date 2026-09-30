# AGENTS.md — slices/synthetic-data/synthetic-data-lifelabs

The **LifeLabs generator**: a `synthetic-data-fundamentals/story` `Story`'s lab
draws as the reports a LifeLabs laboratory prints, and as the FHIR R4
resources the LifeLabs PDF import makes of them, filed on the Patient the
person's pharmacy import made. The reports are `lifelabs-pdf-importer-core`'s
`Report` model and the resources its own synthesis and adoption; nothing here
restates either. No PDF is written. No DOM, no `fs`, no React.

## Shape

The root entry exports `LifeLabs`, `Laboratory` and the `LabRequisition` type:
`import { LifeLabs, Laboratory } from 'synthetic-data-lifelabs'`.

- `src/laboratory.ts` — `Laboratory`: a generator input naming how a lab
  prints each test a story draws (`LifeLabsTest`: the story's test name, the
  printed name, section and group heading, decimals, the reference range per
  administrative gender, comment lines), its address block and licence.
  `between` / `below` / `atLeast` / `eitherSex` build ranges; `printRange` and
  `flagOf` print a range and flag a result against it. A catalogue of real
  tests is data, and lives with the stories.
- `src/lab-requisition.ts` — `LabRequisition`: the `Ordered by:` clinician and
  at most one `Copy To:` clinician, as the report prints them.
- `src/lifelabs.ts` — `LifeLabs.reportsOf`, given the as-of date, the story,
  the laboratory and the requisition: one `LifeLabsReport` per day drawn, rows in the laboratory's
  print order, the flag read off the printed (rounded) result, specimens
  collected in the morning and reported the same evening at seeded minutes;
  fails with `UncataloguedLabTest` for a draw the laboratory does not print.
  `LifeLabs.render(…, pharmacyPatient)`: those reports through the importer's
  `adoptedResourcesOf`, without the report's `Patient`, every `Observation`
  and `DiagnosticReport` `subject` replaced by `pharmacyPatient`.

`synthetic-data-lifelabs/test-helpers` (`src/test-helpers.ts`) holds
`laboratoryArbitrary`, `labDrawsArbitrary`, `labStoryArbitrary` and
`requisitionArbitrary`, drawn from the print's alphabet so a report laid out
and read back is the same report.

## Layering

Depends on `synthetic-data-fundamentals` (the story model and `StoryDay` from
`/story`, `Seeding` from `/seeding`), `lifelabs-pdf-importer-core/synthesis`
(the `Report` types, `adoptedResourcesOf`, `defaultLifeLabsPdfSettings`) and
`fhir-r4` (`AdministrativeGender`, the resource and `Reference` types). The
`/synthesis` subpath keeps the PDF extraction (pdfjs) out. The tests also use
`lifelabs-pdf-importer-core`'s main entry and `/test-helpers` (to print a
report and read it back), `har-importer-core`, `importer-fundamentals`, and
the Rexall and Shoppers generators, as dev dependencies only. Never imports a
`-react`, `-node` or `-tauri` package.

## Rules

- **Results are filed on the pharmacy Patient.** `render` takes the reference
  a pharmacy generator gives for the person (`rexallPatientReferenceOf`,
  `shoppersPatientReferenceOf`), so the results and the prescriptions of one
  person land on one Patient. `lifelabs.round-trip.test.ts` pins that through
  the real HAR importer, and that a Shoppers person's results never name the
  account (`pcid`) Patient.
- **The importer is the proof.** `lifelabs.test.ts` prints each generated
  report with the importer's `layoutDocument`, reads it back with
  `Report.tryFromDocument`, and checks the read-back equals the report and
  `render` equals `decodeLifeLabsPdfDocument` of the print, apart from the
  Patient and the subject.
- **The printed clock is Toronto's**, `defaultLifeLabsPdfSettings.timeZone`,
  as the importer reads a report by default.

## Traps

- **`copyTo` holds at most one clinician.** The importer reads the whole
  `Copy To:` field as one name.
- **A test's `decimals` decide the printed result,** and the flag is read off
  that printed value, so a value that rounds onto a bound flags as the result
  beside it reads.
- **`package.json` `exports` and `vite.config.ts` `pack.entry` must stay in
  sync** (`index`, `test-helpers`).

## References

- [slices/synthetic-data/AGENTS.md](../AGENTS.md) — the slice and its packages.
- [lifelabs-pdf-importer-core AGENTS.md](../../importer/lifelabs-pdf-importer-core/AGENTS.md)
  — the report model, the synthesis and the `/synthesis` subpath.
- [Source Identity Explanation](../../collector/docs/Source%20Identity%20Explanation.md)
  — how adoption keys a Patient, and `adoptedReferenceOf`.
