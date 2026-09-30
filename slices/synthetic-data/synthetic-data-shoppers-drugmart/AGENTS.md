# AGENTS.md — slices/synthetic-data/synthetic-data-shoppers-drugmart

The **Shoppers Drug Mart generator**: a family account's
`synthetic-data-fundamentals/story` `Story`s, filled under a `ShoppersAccount`,
as the HAR a Chrome DevTools export of a mypharmacy.shoppersdrugmart.ca session
would hold. The portal JSON it writes is `shoppers-drugmart-source`'s: every
XHR URL is that package's builder, and every body is typed by that package's
payload schemas. No DOM, no `fs`, no React.

## Shape

The root entry exports `ShoppersHar`, the account types and
`shoppersPatientReferenceOf`:
`import { ShoppersHar, type ShoppersAccount } from 'synthetic-data-shoppers-drugmart'`.

- `src/shoppers-account.ts` — `ShoppersAccount`, the generator's input: the
  account's `pcid`, its phone and address, the `ShoppersStore` that fills for
  it, and the `ShoppersPatient`s it manages (each a `patientId`, a phone and a
  `Story`), the account holder first. The address is typed from
  `CustomerPayload`'s. `shoppersPatientReferenceOf` is the reference to the
  Patient the Shoppers import makes of one managed person (`fhir-r4/identity`'s
  `adoptedReferenceOf` under `SHOPPERS_DRUGMART_SYSTEM`, keyed by their
  `patientId`, never the account's `pcid`), for a result from another source
  to be filed on.
- `src/shoppers-prescription.ts` — `shoppersPrescriptionsOf`: every
  prescription on the account with the ids the portal keys it by (its uuid,
  its seven-digit `prescriptionNumber`, each fill's `dispenseId`), the number
  of the prescription for the same drug it continues, and whether a later one
  continues it. Both feeds read these, so they name a prescription alike.
- `src/customer-payload.ts` — `customerPayloadOf`: the customers body as a
  `typeof CustomerPayload.Encoded`, one `SourcePatient` per managed person.
- `src/prescription-status-payload.ts` — `prescriptionStatusPayloadOf`: one
  prescription's status body as a `typeof SourcePrescription.Encoded`: its
  product, sig, fills left, portal status, expiry, fill dates, the
  `previousPrescription` it continues, and its most recent fill as its one
  `SourceDispense`.
- `src/prescription-history-payload.ts` — `prescriptionHistoryPayloadOf`: the
  history body as a `typeof HistoryPayload.Encoded`, every fill on the
  account as a `SourceHistoryDispense`, newest first.
- `src/shoppers-har.ts` — `ShoppersHar.render(asOf, account)`: the login,
  health-dashboard, prescription-dashboard and prescription-history
  navigations (`ChromeHar.navigationEntryOf`), a status XHR per prescription
  from the dashboard, then the history and customers XHRs from the history
  page (`ChromeHar.entryOf`), on the as-of day, built with `http-archive`'s
  `chromePageOf` / `chromeHarOf`, and returned as an `Effect` of the `.har`
  text (`chromeHarToJson`, pretty).

`synthetic-data-shoppers-drugmart/test-helpers` (`src/test-helpers.ts`) holds
`shoppersCaseArbitrary`: a family account of one to four people, each with a
story from `synthetic-data-fundamentals/test-helpers`.

## Layering

Depends on `synthetic-data-fundamentals` (the story model and `StoryDay` from
`/story`, `Seeding` from `/seeding`, `ChromeHar` from `/chrome-har`),
`http-archive` (the Chrome HAR format), `fhir-r4` (`adoptedReferenceOf`) and
`shoppers-drugmart-source` (the
API URL builders and `SHOPPERS_PORTAL_ORIGIN`, and the `CustomerPayload` /
`SourcePatient` / `SourcePrescription` / `SourceDispense` / `HistoryPayload` /
`SourceHistoryDispense` schemas whose encoded types the bodies are written
as, and `SHOPPERS_DRUGMART_SYSTEM`). The round-trip test also uses
`har-importer-core`, `importer-fundamentals` and `medication-core`, as dev
dependencies only. Never imports a `-react`, `-node` or `-tauri` package.

## Rules

- **The portal's rules are applied here, from the story.** A prescription is
  archived once it has ended or a later prescription for the same drug (the
  same generic name) continues it; it expires 365 days after it was written;
  one that is neither offers a refill while it has repeats left, else a
  renewal. Its `previousPrescription` is the number of the one before it for
  the same drug.
- **The capture's extras are written, and listed.** The literals the source
  never reads — each managed person's `userId` and `storeId`, the body's
  `stores`, a history entry's `prescriberName`, `isArchive` and the store's
  phone, type and address, the customers XHR's `?expand=patients%2Cstores`,
  the page URLs and addresses — are typed as additions to the source's
  schemas, so the source's own fields still type-check against them.
- **The round trip is the proof.** `shoppers-har.round-trip.test.ts` runs
  generated accounts through `har-importer-core`'s `harImporter` and reads the
  result the way the medication views do; every expectation is
  `storyCaseArbitrary`'s reckoning, or the portal's rules applied to it in the
  test, not the functions the generator calls.

## Traps

- **Only a current prescription with a repeat left imports with a dose.**
  The importer reads one fill's supply from `lastFillDate` to `nextFillDate`,
  and the generator writes a `nextFillDate` only while a repeat is left, so
  medication-core amortizes a dose (tablets a day, unitless) for those alone
  and drops the rest. The round-trip test reckons it that way.
- **A prescription's latest fill is in both feeds under one `dispenseId`
  (#803).** The import yields it twice; the test counts it that way.
- **The importer dates a request by its last fill** (`authoredOn` is
  `lastFillDate`), so the test finds a request by its last fill day, and its
  stories give each prescription its own.
- **`package.json` `exports` and `vite.config.ts` `pack.entry` must stay in
  sync** (`index`, `test-helpers`).

## References

- [slices/synthetic-data/AGENTS.md](../AGENTS.md) — the slice and its packages.
- [synthetic-data-fundamentals AGENTS.md](../synthetic-data-fundamentals/AGENTS.md)
  — the story model, `Seeding` and `ChromeHar`.
- [shoppers-drugmart-source AGENTS.md](../../http-extraction/shoppers-drugmart-source/AGENTS.md)
  — the portal JSON and how it imports.
- [shoppers-drugmart-collector AGENTS.md](../../collector/shoppers-drugmart-collector/AGENTS.md)
  — the session the generated capture follows.
