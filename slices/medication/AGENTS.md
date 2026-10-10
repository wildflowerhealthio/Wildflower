# AGENTS.md — slices/medication

The shared base of a patient's medication list: the abstract name-matching
fundamentals and the FHIR R4 adapters onto them, and the fill-date calendar
arithmetic. Two products build on it: the medications app (`apps/medications`),
whose drug-interaction checking (**DDInter**), patient-support / drug-sponsorship
programs (**innoviCares**, **RxHelp**) and calendar screens live with it — see
[apps/medications/AGENTS.md](../../apps/medications/AGENTS.md) — and the Health
Viewer (`apps/health-viewer`), which reads `medication-core/fhir`'s dose
regimens. The matcher is a shared base neither feature owns; each maps its own
catalog onto it.

## Packages

- `medication-core` — the pure matching layer **plus the FHIR R4 adapters**,
  shared by the medications app's features and the Health Viewer. The root export is the matcher: the minimal
  `Medication` value type adapters map their resources onto, `normalizeName` /
  `tokenize` (markup, marks, diacritics and dosage tokens stripped), `scoreName`
  — the exact / strong / partial containment scoring every consumer's matcher is
  built from — and `dedupeMedicationsByName`, which collapses exact-name
  duplicates to the most recent (`authoredOn`) instance. The `medication-core/fhir`
  subpath is the `MedicationRequest → Medication` / `MedicationView` adapter over
  a request that carries its server `id` (`MedicationRequestWithId`, whose `id`
  is the `Medication.id`): the core `Medication` for matching, plus the
  display fields (DIN, description, prescriber, notes, repeat counts, the
  dispensing store's link, estimated next-fill date), and the `hasRefill`
  rule the calendar shares. Each field is
  one small exported accessor (`dinOf`, `descriptionOf`, `repeatsAvailableOf`,
  `storeLinkOf`, …) over the decoded `fhir-r4` `MedicationRequest.Type`,
  reading only the conventional slots the pharmacy sources write (canonical
  `CanadianCodingSystem.Din`, `WildflowerExtension.RepeatsAvailable`,
  `WildflowerExtension.MedicationDescription`,
  `dispenseRequest.performer.reference`) — no pre-promotion fallbacks and no
  vendor urls. The same subpath reads that request as a `DoseRegimen`
  (`medicationRequestToDoseRegimen`, or `medicationRequestsToDoseRegimens` with
  `undated` / `dropped` counts), one file per area: `dosage.ts` reads the first
  instruction's first dose, `per` administration or as a daily total (`d`)
  when `timing.ts` can scale it — `timing.repeat` states frequency per `h` /
  `d` / `wk` / `mo`, a month being 30 days; `amortized-dose.ts` reads a request
  that states no dose (pharmacy imports carry an empty `dosageInstruction`) as
  its dispensed supply amortized into a daily dose — `dispenseRequest.quantity`
  over the days one fill lasts (`dispense-request.ts`'s `supplyDaysPerFillOf`),
  scaled by the Medication's single per-unit ingredient strength when it has
  one; `regimen-period.ts` places it from `validityPeriod.start` or
  `authoredOn` to the validity end or `dispense-request.ts`'s authorized-supply
  end; `dose-regimen.ts` assembles the regimen for the health viewer's dose
  lines, a stated dose always winning over an amortized one. Every `Dose`
  records its `derivation`: `stated` or `amortized`. No DOM, no platform
  imports.
- `medication-calendar-core` — the pure calendar layer: the next-fill /
  exhaustion date math (`nextFillDate`, which reads a `SupplyDuration` from
  `slices/emr/fhir-utility` — a supply duration is a FHIR concept, not a
  calendar one), `deriveCalendarEvents` (pickup on the next-fill date with
  repeats left; a renewal appointment one week before and a marker on the
  exhaustion day without; same-day events of one kind merge into a single
  fluently-titled event), and the Sunday-start 42-cell `monthGrid`. Pure
  date/calendar arithmetic on Effect `DateTime`; no DOM, no FHIR wire
  schemas, no platform imports.

## Rules

### Matching (`medication-core`)

- Keep it catalog-agnostic. A consumer decides _which_ names to score
  (brand vs generic, one drug vs many) and how to break ties; this package only
  says how confidently one name matches another.
- `normalizeName` is idempotent by construction (token filtering, not regex
  substitution) and the property tests pin it — keep new noise rules as token
  predicates.
- **The FHIR R4 adapters live behind the `medication-core/fhir` subpath, never
  the root export.** The root entry stays pure — importing `scoreName` from
  `medication-core` must not pull `fhir-r4`'s schemas into a consumer's bundle.
  Adding an entry means a new key in `vite.config.ts`'s single `pack.entry`
  and a matching `exports` key.
- The two feature cores (`medication-sponsorship-core-js`,
  `medication-interaction-core-js`) stay FHIR-agnostic. `fhir-r4` is this package's
  dependency alone; a feature core that wants a resource takes the
  `medication-core/fhir` output, it does not decode one itself.
- This package is a `fhir-r4` consumer, so both
  [consumer gotchas](../emr/fhir-r4/docs/Consumer%20Gotchas%20Reference.md) apply.
  The accessors read the typed slots directly and never re-declare a FHIR shape
  locally. The two slots `fhir-r4` leaves untyped are decoded with its own
  schemas: `medication[x]` already holds **decoded** values (a `Coding.system`
  is a `URL`, not a string), so it goes through `Schema.typeSchema` of
  `CodeableConcept` / `Reference`; `contained` holds raw wire JSON, so an entry
  goes through the full `Medication.Schema`. And `vp pack` is the
  gate for the TS2883 dts trap, not `vp check` — when the adapter's inferred
  types change, run `vp run -F medication-core build`.
- **The adapter is dialect-free, and stored data is not read around.** A
  resource in a pharmacy's pre-promotion shape — a vendor-only DIN coding, the
  carebook description extension, the store as `external-*` extensions or a
  `supportingInformation` reference, remaining repeats as a `modifierExtension`
  — shows no DIN, store link or remaining repeats, and its description is only
  what its narrative holds (for carebook, a copy of the drug name), never the
  carebook extension. The fix is to re-import it through the source, never a
  fallback reader here. The `prePromotion*` fixtures in
  `src/fhir/test-helpers.ts` pin that none of these vendor shapes is read.
- The adapter depends on `medication-calendar-core` for `nextFillDate`, so the
  matching base imports one feature core. Keep it that way round: nothing in
  `medication-calendar-core` may import `medication-core`.
- The authorized-supply end (`authorizedSupplyEndOf`) advances by
  `fhir-utility`'s `supplyDurationToParts`, the parser `nextFillDate` uses, so
  a supply duration's units read one way everywhere. The daily-total
  conversion (`DAYS_PER_PERIOD_UNIT`, keyed by `fhir-r4`'s `Timing.UnitOfTime`)
  is this package's own table: `Timing.repeat` units are normalised to a rate,
  not added to a date.
- **An amortized dose is a fallback, never a correction.** It is read only
  when the first instruction states no dose, and it assumes the whole fill is
  taken evenly over its supply — an as-needed drug reads as a steady daily
  dose, which is why `derivation` flags it for the UI to say so. It is always
  per day (`per: 'd'`) with no range floor. Repeats do not change it: every
  fill is one `quantity` over one `expectedSupplyDuration`. It is scaled by
  strength only when the contained Medication (the `#id` it references, else
  the first) has exactly one ingredient whose `strength.denominator` is one
  dispensed unit — value 1, in no unit or the dispensed quantity's — and is in
  the numerator's unit; otherwise it stays in the dispensed unit (or none). No
  positive quantity, or no positive supply duration, leaves the request
  without a dose, dropped. The supply days go through the same
  `supplyDurationToParts` as the authorized-supply end, converted to days by
  `DAYS_PER_SUPPLY_PART` (a month 30 days, as `timing.ts` takes it; a year 365).
- The medication-view and dose-regimen readers take `MedicationRequestWithId`
  (`medication-request-with-id.ts`) — the FHIR server always returns an `id`,
  so there is no fallback or positional key: `Medication.id` is `request.id`,
  stable however a page is ordered. A caller decodes through `fhir-r4`'s
  `withMandatoryId(MedicationRequest.Schema)`, as `fhir-r4-react/smart`'s
  `fetchMedicationRequestPage` does, so a request without an `id` fails its
  decode rather than reaching the adapter.

## References

- [apps/medications/AGENTS.md](../../apps/medications/AGENTS.md) — the features built on this base
- [Architecture / slice layering](../AGENTS.md)
- [Testing Reference](../../docs/Testing/Testing%20Reference.md) — property tests are the default here
