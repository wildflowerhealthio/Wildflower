# AGENTS.md — slices/http-extraction/rexall-be-well-source

The **Rexall Be Well source**: the single definition of how the Rexall Be Well
portal's carebook STU3 dialect decodes into FHIR R4 resources, exported as one
`SourceDescriptor` value — `rexallBeWellSource`, whose pre-adopted
`responseKinds` an archive import extracts with. The live
`rexall-be-well-collector` scraping plan (browser-driven, in `slices/collector`)
consumes the same response-kind tuple by reference, so the two consumers can
never disagree on a decode.

## Shape

- `src/response-kinds/profile-response-kind.ts` — `…/carebook/profile` → one R4
  `Patient`.
- `src/response-kinds/medication-list-response-kind.ts` —
  `…/carebook/medications` → R4 `MedicationRequest` + `MedicationDispense`
  resources.
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
`MedicationDispense.location`) because STU3 has no slot for them. Promoting
inside it would turn each promotion into a round-trip invariant on a slice whose
job is _generic_ STU3⇄R4. These are Rexall-specific readings of a vendor
dialect, so they live beside the rest of the carebook knowledge.

What moves (lift-and-drop — the extension is removed once the value lands):

| Extension                                               | Conventional home                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `medicationrequest/…/do-not-perform`                    | `MedicationRequest.doNotPerform` — an exact 1:1; the extension exists only because the source is STU3   |
| `medicationrequest/…/request-type` (`fill` \| `refill`) | `MedicationRequest.category` — `intent` is a constant `order` and carries no signal                     |
| `medicationrequest/…/medication-processor`              | `dispenseRequest.performer`                                                                             |
| `medicationdispense/…/medication-processor`             | `MedicationDispense.location`                                                                           |
| `medication/…/description`                              | the contained `Medication`'s narrative (`text.div`), **only when** it is absent or the `code.text` copy |
| `medication/…/strength`                                 | merged into `Medication.ingredient[0].strength`, **only when it parses** as `<number> <unit>`           |

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
- **Extensions are consumed by array index, never by url.** The dialect writes
  several urls twice and `promote.ts` reads only the first, so dropping by url
  would delete a second copy nobody examined. Same reasoning inside a contained
  Medication, where each extension entry is decoded on its own: one malformed
  entry then disables only itself instead of switching off every promotion on
  the drug that carries it.
- **`parseStrength` takes `.` as the only decimal separator.** Rexall is an
  English-Canadian pharmacy, so `"1,000 mg"` is one thousand milligrams written
  with a thousands separator. Reading that comma as a decimal point would write
  a 1 mg strength and drop the extension holding the truth — a silent 1000×
  dosage error in the clinical record. The string simply fails to match instead.
- **The promoted narrative is XHTML, not the bare description.** R4 types
  `Narrative.div` as `xhtml` and requires a single `<div>` in the XHTML
  namespace; a conformant server rejects anything else on write. `promote.ts`
  wraps and escapes, and `medication-sponsorship-react` extracts the text
  content back out — the two are a pair.
- **`external-store-id` stays an extension on purpose.** `Reference.identifier`
  is 0..1 and the dialect already fills it on the processor reference with
  carebook's own pharmacy id; giving the store number that slot would discard a
  vendor identifier. `medication-sponsorship-react` reads it where it is to
  build the store-locator link.
- **The redundant extensions are kept, deliberately.** `when-requested` (equals
  `whenPrepared`), both `estimated-pick-up`s (equal `whenHandedOver`),
  `medicationrecord-processor` (byte-equal to `medication-processor`), the `v2`
  `number-of-repeats-available` (equals its `v1` sibling) and the
  `prescription-order` stub (`display: 'todo'`) are all redundant with something
  that already carries the value. Dropping them is a separate decision from
  promoting misplaced ones, so promotion leaves them.
- **`medication-processor-timezone` cannot be applied.** Every dialect timestamp
  arrives `+00:00` and this extension is their real offset, but both schemas
  type `dateTime` as `Schema.DateTimeUtc`, which normalizes to UTC on decode —
  so a pick-up at 20:09 local can render on the wrong day and there is nowhere
  for the offset to survive. Fixing it means changing the `dateTime` handling in
  `fhir-r4`, not this package.
- **`medication-sponsorship-react` reads this dialect too**, off the same
  decoded resources. It reads the description (**the extension first**, the
  narrative as the post-promotion fallback), the DIN, the `v2` repeats
  modifierExtension, and `external-system-source` + `external-store-id` for the
  store link. Changing what this package emits can break that view — check it.
  The read order is load-bearing in one direction only: exactly one of the two
  is present on a resource this package wrote, but a resource that has _not_
  been promoted (already in the store, or from the Medications app's own FHIR
  server) carries both, and its narrative is the dialect's byte-copy of
  `code.text` — i.e. the drug name the card already shows as its title.
  `medication-sponsorship-react` also keeps its own hand-maintained copy of five
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
