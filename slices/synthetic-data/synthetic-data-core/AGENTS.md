# AGENTS.md — slices/synthetic-data/synthetic-data-core

Pure tooling for synthetic health data: the story model, and one renderer per
source that turns a story into the file that source would produce. No DOM, no
`fs`, no React. The stories themselves, and the products they prescribe, live
in [`wildflowerhealthio/synthetic-data`](https://github.com/wildflowerhealthio/synthetic-data).

## Namespaces

One namespace per module, in the `effect` style, from the flat root entry:
`import { Prescription, RexallHar, ShoppersHar } from 'synthetic-data-core'`.

- **`StoryDay`** (`src/story-day.ts`) — a day relative to the as-of date
  (`0` is the as-of day, `-30` a month before). `toDateTime` / `toIsoDate`
  date one; only the as-of instant's UTC calendar day matters (`asOfDayOf`).
- **`Seeded`** (`src/seeded.ts`) — `uuidOf`, `integerOf`, `digitsOf`: values
  hashed (FNV-1a over `joinIdComponents`) from the keys naming what they
  belong to, so adding a prescription leaves every other one's ids and times
  untouched.
- **`Person`** (`src/person.ts`) — demographics; `birthDateOf(person, asOf)`
  keeps the person `age` on every as-of day.
- **`DrugProduct`** (`src/drug-product.ts`) — the type of a marketed product
  by DIN (brand, generic name, strength, form, company), and the labels a
  pharmacy prints for it (`labelOf`, `strengthLabelOf`). A union: a
  `DpdProduct` (keyed by the DPD's `drugCode`) or a `NaturalHealthProduct`
  (`drugCode: null`, keyed by the LNHPD's `lnhpdId`) — a Transitional DIN the
  DPD no longer lists. No products: a data set's chosen, verified products are
  the data repo's.
- **`Prescription`** (`src/prescription.ts`) — an Rx as a pharmacy holds it:
  product, dosing, supply per fill, repeats, prescriber, why it was `written`
  (`start`, `dose-change`, `renewal`, `resume`, `generic-switch`), when and why
  it `ended` (`dose-change`, `hold`, `generic-switch`, `stop`), and its
  `fillDays` (`fillDaysOnCadence` writes a refill cadence with days late). A
  dose may be half a tablet (`tabletsPerDose: 0.5`, `1/2 TABLET` on the sig)
  where no tablet of that strength is marketed. An optional `interchange`
  switches the product from one fill on — the same prescription, a new DIN
  (`productOnFillOf`, `currentProductOf`); a generic switch written as a new
  prescription is `written.reason: 'generic-switch'` instead. The sig,
  quantity per fill, daily dose, repeats remaining and status on the as-of day
  are all derived (`sigOf`, `quantityPerFillOf`, `dailyDoseOf`,
  `repeatsRemainingOf`, `statusOf`), so a renderer never restates the story.
  A medication episode is a drug's prescriptions read in order.
- **`LabDraw`** (`src/lab-draw.ts`) — a result a story's dose changes answer
  to (test, value, unit, day). Rendering labs is the lab source's job.
- **`Story`** (`src/story.ts`) — one person's record: `person`,
  `prescriptions`, `labDraws`.
- **`ChromeHar`** (`src/har/chrome-har.ts`) — the HAR 1.2 envelope a Chrome
  DevTools export writes (pages, `_initiator` / `_resourceType`, phase
  timings, bodies as text in `content.text`): `pageOf`, `entryOf`,
  `archiveOf`, `toJson`, and the navigations' `DOCUMENT_REQUEST_HEADERS` and
  `appShellOf`. Every HAR renderer builds on it.
- **`RexallHar`** (`src/rexall/`) — `render(asOf, story, account)`: a
  letsbewell.ca session (sign-in page, prescriptions page, the profile XHR and
  the STU3 prescriptions searchset) as `.har` text. `carebook-profile.ts` and
  `carebook-searchset.ts` build the two bodies in the carebook dialect; each
  prescription is a `MedicationRequest` with its product contained, and its
  most recent fill a `MedicationDispense` sharing the request's `id`. Both
  name the product that fill dispensed (`Prescription.currentProductOf`), so an
  `interchange` reads the same here as in the Shoppers status feed.
- **`ShoppersHar`** (`src/shoppers/`) — `render(asOf, account)`: a
  mypharmacy.shoppersdrugmart.ca session in `shoppers-drugmart-collector`'s
  page order (login, health dashboard, the prescription dashboard with one
  `prescription-status` XHR per prescription, then the prescription-history
  page with the history and customers XHRs) as `.har` text. A
  `ShoppersAccount` (`shoppers-account.ts`) is the holder, the store and the
  managed people, each with their `Story`. `shoppers-prescription.ts` keys
  every prescription and fill (hashed uuids, a seven-digit
  `prescriptionNumber`, `previousPrescription` pointing at the previous
  prescription for the same drug, archived once a later one continues it);
  `customer-payload.ts`, `prescription-status-payload.ts` and
  `prescription-history-payload.ts` build the three bodies. The status feed
  names the product on the label now and holds only the latest fill; the
  history feed lists every fill with the DIN dispensed that day.

## Adding a source

A new source is a renderer module beside `rexall/` and `shoppers/` that reads `Story` values
(and the person's account on that source), builds the source's wire shape from
the source package's own constants, and — for HAR sources — wraps it with
`ChromeHar`. It ships with a round-trip test through the real importer that
asserts that generated stories, not the renderer's own output, come back.

## Layering

Depends on `effect`, `kitchen-sink` (`fnv1a64`, `utf8Bytes`), `fhir-r4`
(`joinIdComponents`, the key fold `Seeded` hashes) and `rexall-be-well-source`
(the carebook extension, identifier and coding catalogue — spelled once,
there). The Shoppers portal's JSON has no such catalogue —
`shoppers-drugmart-source` exports only its descriptor and `sid` system; its
identifier systems name the FHIR it writes, not the wire — so the Shoppers
payloads are typed here, after that package's test fixtures. The importers and
readers the round-trip tests drive
(`har-importer-core`, `importer-fundamentals`, `http-archive`,
`medication-core`) are dev dependencies only. Never imports a
`-react`, `-node` or `-tauri` package.

## Testing

Everything is property-tested over generated stories; nothing here is a
particular person's story.

- `src/arbitraries.test-helpers.ts` — the arbitraries: as-of instants,
  people, products (plausible 8-digit DINs, strengths, manufacturers), dosings,
  and `storyCaseArbitrary`, which lays out one to four drug episodes — a start,
  then dose changes, renewals once the repeats run out, holds and resumes,
  generic switches — with on-time, late and missed refills, now and then a
  half-tablet dose, an interchange on a refill or a natural health product,
  shifted to end before the as-of day. Each story comes paired with what its pharmacy records
  must say (name, brand and DIN on the label, each fill's DIN, quantity,
  supply, repeats, status, sig, last fill, amortized daily dose, the
  prescriptions it continues and is continued by), worked out from the
  generated inputs rather than by the model functions the renderers call.
  `shoppersCaseArbitrary` puts one to four such stories on a family account.
- `src/rexall/rexall-har.test.ts` — properties over the as-of date: byte-identical
  renders within a day, every timestamp shifting with the as-of date, and an
  archive `http-archive` decodes.
- `src/rexall/rexall-har.round-trip.test.ts` — generated stories' HARs through
  `harImporter.decode`, then `medication-core`, compared per prescription with
  the arbitrary's expectations: the request, its one linked dispense, and its
  amortized dose.
- `src/shoppers/shoppers-har.test.ts` — the Rexall properties again for the
  Shoppers archive over generated accounts, plus the collector's page and XHR
  order.
- `src/shoppers/shoppers-har.round-trip.test.ts` — generated accounts' HARs
  through `harImporter.decode`, then `medication-core`: the Patients (one per
  managed person, plus the account Patient), each request's brand, DIN, sig,
  fills left, quantity, status, prescriber and prior-prescription link, every
  fill's dispense with the DIN dispensed that day, the status feed's latest
  fill, and that no dose regimen is read yet (#798).

## The Shoppers import, as it comes out

- **The account holder has two Patients.** `CustomerResponseKind` emits one
  Patient per `customer.patients[]` entry and an account Patient keyed by
  `pcid` that `link.seealso`s them, so the holder appears twice — expected,
  until records are linked by hand. Neither carries a birth date or gender:
  the portal sends none.
- **The latest fill arrives twice.** The status feed and the history feed both
  carry it under one `dispenseId`, so the import holds it twice under one id.
- **medication-core reads no dose from it (#798).** The importer writes
  `MedicationRequest.status` as `stopped` (archived or expired) or `unknown`
  (everything else), states the dose only as `dosageInstruction.text`, and
  writes no `expectedSupplyDuration`; `medicationRequestsToDoseRegimens` drops
  every request. The dose over time is in the sig text alone. The portal's
  `numFillsLeft` lands in `numberOfRepeatsAllowed`.

## References

- [slices/synthetic-data/AGENTS.md](../AGENTS.md) — the slice and its rules.
- [rexall-be-well-source AGENTS.md](../../http-extraction/rexall-be-well-source/AGENTS.md)
  — the dialect the Rexall renderer writes, and what its promotion reads.
- [Property Testing Reference](../../../docs/Testing/Property%20Testing%20Reference.md)
