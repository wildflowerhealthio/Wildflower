# AGENTS.md — slices/synthetic-data/synthetic-data-rexall-be-well

The **Rexall Be Well generator**: a `synthetic-data-fundamentals` `Story`,
filled under a `RexallAccount`, as the HAR a Chrome DevTools export of a
letsbewell.ca session would hold. The carebook dialect it writes is
`rexall-be-well-source`'s: every URL, extension, identifier and coding system
is that package's constant, and every body is typed by that package's schemas.
No DOM, no `fs`, no React.

## Shape

The root entry exports `RexallHar` and the `RexallAccount` type:
`import { RexallHar, type RexallAccount } from 'synthetic-data-rexall-be-well'`.

- `src/rexall-account.ts` — `RexallAccount`, the generator's input beside the
  story: the profile's `uid` and `reportingGuid` (typed from
  `CarebookProfile`'s identifiers), the store number, the carebook pharmacy
  location id, and the `StoryDay`s the account was created and last updated.
- `src/carebook-profile.ts` — `profileOf`: the `…/enduser/profile/v2/me` body
  as a `typeof CarebookProfile.Encoded`, from the story's `Person` and the
  account.
- `src/carebook-searchset.ts` — `searchsetOf`: the prescriptions list's STU3
  searchset as a `typeof MedicationBundle.Encoded`. Each prescription is one
  `MedicationRequest` with its product as a contained `Medication`; its most
  recent fill is one `MedicationDispense` sharing the request's `id` and
  identifiers, as the capture shows. `medicationListUrlFor` is the account's
  `medicationListUrlOf`.
- `src/rexall-har.ts` — `RexallHar.render(asOf, story, account)`: the sign-in
  and prescriptions page navigations, then the profile and searchset XHRs, on
  the as-of day, built with `HarCapture` and returned as an `Effect` of the
  `.har` text.

`synthetic-data-rexall-be-well/test-helpers` (`src/test-helpers.ts`) holds
`rexallAccountArbitrary`; the stories come from
`synthetic-data-fundamentals/test-helpers`.

## Layering

Depends on `synthetic-data-fundamentals` (the story model, `StoryDay`,
`Seeded`, `HarCapture`), `rexall-be-well-source` (the dialect's constants,
`carebookTimestampOf`, the tunnel URLs, and the `CarebookProfile` /
`MedicationBundle` / `MedicationResource` schemas whose encoded types the
bodies are written as), and `fhir-r4` / `fhir-stu3-as-r4` for the encoded
datatype types those schemas are built on. The round-trip test also uses
`har-importer-core`, `importer-fundamentals` and `medication-core`, as
dev dependencies only. Never imports a `-react`, `-node` or `-tauri` package.

## Rules

- **Bodies are built encoded.** The generator writes `.Encoded` values
  directly instead of encoding decoded ones: `Schema.DateTimeUtc` encodes as
  `…000Z`, and the dialect writes every timestamp `+00:00`
  (`carebookTimestampOf`).
- **The dialect is spelled once.** A URL, extension or system the source
  package names is imported from it. The literals written here (the
  `input-source` value `Sync`, the pharmacy's `America/Toronto` zone, the
  `PrescriptionOrder/null` stub, the page URLs and addresses) are capture
  values `rexall-be-well-source` never reads.
- **The round trip is the proof.** `rexall-har.round-trip.test.ts` runs
  generated stories through `har-importer-core`'s `harImporter` and reads the
  result the way the medication views do; every expectation is
  `storyCaseArbitrary`'s own reckoning, not the model functions the generator
  calls.

## Traps

- **`package.json` `exports` and `vite.config.ts` `pack.entry` must stay in
  sync** (`index`, `test-helpers`).
- **`StoryDay.instantOn` hashes only its keys.** Every call names what it
  dates (the prescription, and which fill), so two events never share a time
  of day by accident.
- **The contained `Medication` carries `status` and `manufacturer`,** which
  `fhir-stu3-as-r4`'s STU3 `Medication` does not model; its type adds them
  from `fhir-r4`'s R4 `Medication`, which spells them the same.

## References

- [slices/synthetic-data/AGENTS.md](../AGENTS.md) — the slice and its packages.
- [synthetic-data-fundamentals AGENTS.md](../synthetic-data-fundamentals/AGENTS.md)
  — the story model and `HarCapture`.
- [rexall-be-well-source AGENTS.md](../../http-extraction/rexall-be-well-source/AGENTS.md)
  — the carebook dialect and the capture this generator is modelled on.
