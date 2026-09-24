# AGENTS.md — slices/http-extraction/rexall-be-well-source

The **Rexall Be Well source**: the single definition of how the Rexall Be Well
portal's carebook STU3 dialect decodes into FHIR R4 resources, exported as one
`SourceDescriptor` value — `rexallBeWellSource`, whose pre-adopted
`responseKinds` an archive import extracts with. The live
`rexall-be-well-collector` scraping plan (browser-driven, in `slices/collector`)
consumes the same response-kind tuple by reference, so the two consumers can
never disagree on a decode.

## Shape

- `src/response-kinds/profile-response-kind.ts` —
  `https://rexall-prd-tunnel.letsbewell.ca/enduser/profile/v2/me` → one R4
  `Patient`.
- `src/response-kinds/medication-list-response-kind.ts` —
  `https://rexall-prd-tunnel.letsbewell.ca/enduser/health/v1/fhir/stu3/pharmacy/Location?…`
  → R4 `MedicationRequest` + `MedicationDispense` resources.
- `src/carebook.ts` — the carebook STU3 dialect decoder.
- `src/promote.ts` — STU3-to-R4 promotion helpers.
- `src/bundle.ts` — searchset Bundle unwrapping.
- `src/source-system.ts` — `REXALL_CAREBOOK_SYSTEM`, the Wildflower-minted
  `sid` URI each kind's `tryRecognize` mints and adoption keys under.
- `src/response-kinds.ts` — `rexallBeWellResponseKinds` (internal): the kinds
  mapped through `adoptUnderRecognizedRoot`, stable by identity at module scope.
- `src/source.ts` — `rexallBeWellSource`, the package's primary export.
- `src/fixtures/` — anonymized `web-trace` capture fixtures the bundle,
  promotion, and response-kind suites decode against (`prescriptions-searchset.json`,
  `profile-me.json`, `detail-bundle.json`, `list-bundle.json`). The
  collector keeps its own copies of `prescriptions-searchset.json` /
  `profile-me.json` for its plan-level `config.test.ts`.

## Layering

Pure like a `-core`: no DOM, no `fs`, no React. Depends on
`http-extraction-fundamentals`, `fhir-r4`, `fhir-stu3-as-r4` (the STU3⇄R4 schemas
the bundles decode with), `effect`, and `kitchen-sink`. Never imports from
`slices/collector` or `slices/importer` — those consume this package, never the
reverse.

## Extension Promotion

The dialect is extension-heavy, and several of those extensions carry values R4
has a conventional field for. `src/promote.ts` moves them, running on the R4
output of the `fhir-stu3-as-r4` transform.

**It is deliberately a post-step in this package, not part of that transform.**
`R4FromStu3Schema` is bidirectional, and its encode side rejects by name most of
what gets written here (`category`, `doNotPerform`, `dispenseRequest.performer`,
`MedicationDispense.location`, `dispenseRequest.extension`) because STU3 has no
slot for them. Promoting inside it would turn each promotion into a round-trip
invariant on a slice whose job is _generic_ STU3⇄R4. These are Rexall-specific readings of a vendor
dialect, so they live beside the rest of the carebook knowledge.

**How it is built.** Each resource is promoted by a `pipe` of small
`(resource) => resource` steps — one per promotion, over the
`MedicationRequest`, its `dispenseRequest`, the `MedicationDispense`, and each
contained `Medication`. A step decodes what it reads with an Effect Schema
first (the carebook extension shapes decode straight to the value they carry;
`fhir-r4`'s `CodeableConcept` / `Reference` type schemas re-read the `any`-typed
`value[x]` / `medication[x]` slots), then — only if the value lands — writes the
target slot **and** drops the source extension in the same edit. Nothing is
remembered between steps. Add a promotion by adding a step to the pipe, not by
threading state through one.

What moves (lift-and-drop — the extension is removed once the value lands):

| Extension                                                                                        | Conventional home                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `medicationrequest/…/do-not-perform`                                                             | `MedicationRequest.doNotPerform` — an exact 1:1; the extension exists only because the source is STU3                                                                                             |
| `medicationrequest/…/request-type` (`fill` \| `refill`)                                          | `MedicationRequest.category` — `intent` is a constant `order` and carries no signal                                                                                                               |
| `medicationrequest/…/medication-processor`                                                       | `dispenseRequest.performer`                                                                                                                                                                       |
| `medicationdispense/…/medication-processor`                                                      | `MedicationDispense.location`                                                                                                                                                                     |
| `common/…/external-system-source` (`RexallPharmacy`) + `medicationrequest/…/external-store-id`   | `dispenseRequest.performer.reference` = `https://www.rexall.ca/storelocator/store/<id>`, **only when both** are present; `performer.identifier` (carebook's pharmacy id) and `display` are kept   |
| `common/…/external-system-source` (`RexallPharmacy`) + `medicationdispense/…/external-store-id`  | `MedicationDispense.location.reference`, the same URL — mirroring the request                                                                                                                     |
| `medicationrequest/…/number-of-repeats-available`, `v1` (`positiveInt`) **and** `v2` (`decimal`) | one `dispenseRequest.extension` under `fhir-r4`'s `WildflowerExtension.RepeatsAvailable`, as `valueInteger`; `v1` preferred, `v2` the fallback; each copy consumed only if it carries that number |
| `medication/…/description`                                                                       | the contained `Medication`'s narrative (`text.div`), **only when** it is absent or the `code.text` copy                                                                                           |
| `medication/…/strength`                                                                          | merged into `Medication.ingredient[0].strength`, **only when it parses** as `<number> <unit>`                                                                                                     |

The DIN is not an extension, but it is lifted the same way: every
`medication-din-code` (vendor) coding — on a contained `Medication.code` and on
either resource's `medicationCodeableConcept` — gains exactly one twin under
`fhir-r4`'s `CanadianCodingSystem.Din` (`http://hl7.org/fhir/NamingSystem/ca-hc-din`)
carrying the same `code`. Additive: the vendor coding stays, first.

The same contained-Medication promotions run on `MedicationDispense.contained`.
No dispense in the capture inlines a Medication, but the slot is identical, and
one that did would otherwise be stored differently from the same drug on the
request beside it.

Two things ride along, both fixing accuracy bugs rather than moving extensions:

- **The contained `Medication` is linked.** The dialect populates
  `medicationCodeableConcept` and leaves `contained[0]` unreferenced, so its
  `form`, `manufacturer`, strength and description are unreachable.
  `medicationReference: '#id'` replaces the inline concept (`medication[x]` is a
  choice, and the contained `code` is byte-identical to it) — **carrying the
  concept's label onto `Reference.display`**, so a reader that only renders
  `medication[x]` still has a name. A `medicationReference` already pointing
  somewhere that is not a `#fragment` is left alone: that is an external
  Medication, not an orphan to adopt.
- **Supply durations get their unit.** `dispenseRequest.expectedSupplyDuration`
  and `MedicationDispense.daysSupply` both arrive as a bare `{ value }`. They
  are days; the UCUM `d` is spelled out.

### Traps

- **A promotion that fails leaves its extension alone.** An unparseable
  strength, a value that will not decode, a contained Medication with no
  `code` (**including an explicit `"code": null` — `contained` is raw
  passthrough JSON, so nothing filters those upstream**), a
  `medication-processor` on a request that carries no `dispenseRequest` to hold
  it, a narrative already holding real content — each is a no-op, never a silent
  drop.
- **A step drops exactly the entry it read, never every entry at its url.**
  The dialect writes several urls twice and `promote.ts` reads only the first,
  so dropping by url would delete a second copy nobody examined. Inside a
  contained Medication the rule is "the first entry that decodes": each
  extension entry is decoded on its own, so one malformed entry disables only
  itself instead of switching off every promotion on the drug that carries it.
- **`contained` is decoded at the boundary, and all-or-nothing per entry.**
  `contained` is untyped passthrough in `fhir-r4`, so each entry is decoded
  once against a local `ContainedMedication` wire schema (string `Coding.system`,
  explicit `null`s tolerated, every unmodelled key carried through untouched).
  An entry that does not decode — another resource type, or a Medication whose
  `code`, `text`, `ingredient` or `id` has the wrong shape — is returned exactly
  as it went in: no DIN twin, no narrative, no strength, and it is not linked.
- **`StrengthRatioFromString` takes `.` as the only decimal separator.** Rexall is an
  English-Canadian pharmacy, so `"1,000 mg"` is one thousand milligrams written
  with a thousands separator. Reading that comma as a decimal point would write
  a 1 mg strength and drop the extension holding the truth — a silent 1000×
  dosage error in the clinical record. The string simply fails to match instead.
- **The promoted narrative is XHTML, not the bare description.** R4 types
  `Narrative.div` as `xhtml` and requires a single `<div>` in the XHTML
  namespace; a conformant server rejects anything else on write. `promote.ts`
  wraps and escapes, and `medication-core` extracts the text
  content back out — the two are a pair.
- **The store number lands on `Reference.reference`, never
  `Reference.identifier`.** `identifier` is 0..1 and the dialect already fills
  it on the processor reference with carebook's own pharmacy id; giving the
  store number that slot would discard a vendor identifier. The store-locator
  URL goes on `reference` instead — a literal reference to a public, non-FHIR
  page, the convention the Shoppers source shares. It **replaces** the
  processor's own `reference` (`rexall-pharmacy-location/<id>`), which resolves
  to nothing and repeats the id `identifier` already holds. An absolute URL is
  also left untouched by adoption's reference rewrite.
- **The store pair is all-or-nothing.** `external-system-source` must read
  `RexallPharmacy` **and** a non-blank `external-store-id` must be present;
  either one alone is not a store link, so both stay. On a request, the pair is
  consumed only when `dispenseRequest` exists to hold the link (a fresh
  `performer` is created when no `medication-processor` supplied one — the
  capture's `mr-0002`); a dispense always has a `location` slot.
- **The two repeats copies are consumed by value, not by url.** Each is dropped
  only if it decodes to the same whole, non-negative number that was promoted.
  A copy that disagrees, is fractional or negative, or does not decode stays in
  `modifierExtension` — a value nobody promoted is never silently lost.
- **The other redundant extensions are kept, deliberately.** `when-requested`
  (equals `whenPrepared`), both `estimated-pick-up`s (equal `whenHandedOver`),
  `medicationrecord-processor` (byte-equal to `medication-processor`) and the
  `prescription-order` stub (`display: 'todo'`) are all redundant with something
  that already carries the value. Dropping them is a separate decision from
  promoting misplaced ones, so promotion leaves them. The `v2` repeats copy is
  not on this list: its value lands in the Wildflower extension alongside
  `v1`'s, so it is consumed like any promoted extension.
- **`medication-processor-timezone` cannot be applied.** Every dialect timestamp
  arrives `+00:00` and this extension is their real offset, but both schemas
  type `dateTime` as `Schema.DateTimeUtc`, which normalizes to UTC on decode —
  so a pick-up at 20:09 local can render on the wrong day and there is nowhere
  for the offset to survive. Fixing it means changing the `dateTime` handling in
  `fhir-r4`, not this package.
- **`medication-core` reads this dialect too**, off the same
  decoded resources. It reads the description (**the extension first**, the
  narrative as the post-promotion fallback), the DIN (the vendor coding, still
  present), the `v2` repeats modifierExtension, and `external-system-source` +
  `external-store-id` for the store link. Promotion **consumes** those last
  two, so a resource this package writes shows no store link or
  remaining-repeats count in that view until its reader moves to the
  conventional slots (issue #583). Changing what this package emits can break
  that view — check it.
  The read order is load-bearing in one direction only: exactly one of the two
  is present on a resource this package wrote, but a resource that has _not_
  been promoted (already in the store, or from the Medications app's own FHIR
  server) carries both, and its narrative is the dialect's byte-copy of
  `code.text` — i.e. the drug name the card already shows as its title.
  `medication-core` also keeps its own hand-maintained copy of five
  of these URLs plus `REXALL_SYSTEM_SOURCE`; the two catalogues are not shared
  because that slice does not depend on this one. Change one side, check the
  other.
- **`valuePositiveInt` used to decode to `null`.** `positiveInt` was not in
  `fhir-r4`'s datatype registry, so `sort-order` and the `v1`
  `number-of-repeats-available` were silently lost, and only the `v2`
  `valueDecimal` copy survived. It is registered now; the dual-write is why
  nobody noticed. It is registered **without** the spec's `> 0` refinement, and
  that is deliberate: carebook sends `valuePositiveInt: 0` for a prescription
  with no repeats left, and a refinement failure inside an extension fails the
  whole resource, which `medicationOrNull`'s catch-all turns into the
  MedicationRequest silently vanishing from the list. See the deviation note in
  [fhir-r4's Client Capabilities Reference](../../emr/fhir-r4/docs/Client%20Capabilities%20Reference.md).

## Fixtures & the capture

The `carebook.ts` constants and the **structure** of `src/fixtures/` are
reconciled against a real (anonymized) `web-trace` capture of the prescriptions
page and the profile endpoint. The fixture _values_ are readable stand-ins; the
shapes, URLs and coding systems are the capture's. What that capture settled:

- **Every extension URL and coding system.** The shape is
  `{base}/{resource}/extension/{name}` with a `common/` namespace, not the flat
  `{base}/{name}` this package asserted before. `RequestType` is
  `fill | refill`, not `order | refill`. See `carebook.ts` for the two
  `schemas`/`schema` host spellings and which side each system falls on.
- **Profile field names.** `ProfileResponseKind` reads `data.identifiers.uid` /
  `data.identifiers.email` / `data.names.firstName` / `data.names.lastName` /
  `data.birthDate` / `data.zipPostalCode`. The name and postal-code paths are
  **not** flat — reading them as `data.firstName` / `data.address.postalCode`
  (which this package did) silently yields a nameless, address-less Patient,
  because the decode is lenient by design. Blank strings are treated as absent;
  the payload sends `""` for a name it has no value for.
- **The `_revinclude` parameters.** `MedicationRequest` /
  `MedicationDispense` / `DocumentReference` / `Immunization`, each on
  `extension.medicationrecord-processor`.

**Still open — whether the searchset really carries non-medication entries.**
The capture's bundle held only `MedicationRequest` + `MedicationDispense` — no
`Location`, `DocumentReference` or `Immunization` — despite `total: 91` against
12 entries and all four `_revinclude`s being present. Whether the anonymizer
stripped them or the server omits them is not determinable from that file, so the
fixture keeps one of each and `MedicationListResponseKind` keeps its
drop-and-count path. (The collector's own open questions — the unverified login
selectors and settle holds, and whether a detail crawl is worth adding — live in
that package's AGENTS.md.)

## Data-quality notes from the capture

Observed, not acted on — worth knowing before trusting a field:

- A `MedicationRequest` and its `MedicationDispense` **share the same `id`** and
  the same identifier pair. Anything keying on id alone rather than
  (resourceType, id) collapses the two — which is why the kinds are adopted with
  `adoptUnderRecognizedRoot`, whose derivation takes the resource type as an
  input.
- `authorizingPrescription[].reference` does **not** resolve to any bundle
  entry; the working link is `identifier.value`. The two entries are the same
  reference twice, differing only in `identifier.system` (`…-type-order` /
  `…-type-refill`).
- `whenPrepared` / `whenHandedOver` are byte-equal to the `when-requested` /
  `estimated-pick-up` extensions — so for a `completed` dispense,
  `whenHandedOver` may be an _estimate_, not an actual hand-over.
- `note[0].text` is the **sig** (`"TAKE 1 TABLET (=20MG) BY MOUTH ONCE DAILY"`),
  not an annotation. Its conventional home is `dosageInstruction[0].text`; it is
  left in `note` for now.
- `requester.agent.reference` and `subject.display` arrive as empty strings
  where the field should simply be absent.

## References

- [slices/http-extraction/AGENTS.md](../AGENTS.md) — the slice this package
  belongs to.
- [rexall-be-well-collector AGENTS.md](../../collector/rexall-be-well-collector/AGENTS.md)
  — the live collector built from these entities.
- [Source Identity Explanation](../../collector/docs/Source%20Identity%20Explanation.md)
  — why a resource is re-keyed under a derived local id.
