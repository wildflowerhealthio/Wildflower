# AGENTS.md — slices/http-extraction/shoppers-drugmart-source

The **Shoppers Drug Mart source**: the single definition of how the Shoppers
"mypharmacy" portal's bespoke JSON decodes into FHIR R4 resources, exported as
one `SourceDescriptor` value — `shoppersDrugMartSource`, whose pre-adopted
`responseKinds` an archive import (`har-importer-core`) extracts with. Unlike
`fhir-r4-source` (which
decodes native FHIR JSON) and `rexall-be-well-source` (which decodes a carebook
STU3 dialect), this source **synthesizes** R4 resources directly from
non-FHIR portal JSON.

It also exports the portal's dialect itself — the API URLs, the payload
schemas and the identifier catalogue — so a producer of portal traffic
(`synthetic-data`'s Shoppers generator) spells the dialect from this package
rather than a copy, and what it writes is what the response kinds read.

## Shape

- `src/response-kinds/customer-response-kind.ts` —
  `…/api/v1/customers/pcid/<uuid>` → one demographic `Patient` per managed
  person, the holder included, and nothing for the account itself. When the
  account's `patients` holds exactly one entry, a person, the account's email
  and phone join that person's `telecom` (each once); with any other entry
  beside them (another person, or one that does not decode), they are
  dropped. The account's own name and address are not read.
- `src/response-kinds/prescription-response-kind.ts` —
  `…/prescriptions/:uuid/prescription-status` → one `MedicationRequest` + one
  `MedicationDispense` per dispense entry.
- `src/response-kinds/prescription-history-response-kind.ts` —
  `…/prescription-history?customerId=…` → one `MedicationDispense` per history
  entry (no Patient, no MedicationRequest), its `subject` the **account** by
  identifier alone (see [Conventional slots](#conventional-slots)).
- `src/response-kinds/medication-wire.ts` — the `medicationCodeableConcept`
  builder (brand/chemical text + DIN codings) shared by the two dispense-emitting
  entities.
- `src/portal-url.ts` — the API's URLs: `SHOPPERS_API_BASE_URL` and the
  three XHR builders `customerUrlOf`, `prescriptionStatusUrlOf` and
  `prescriptionHistoryUrlOf`. The response kinds build their matchers from
  `SHOPPERS_API_BASE_URL`, through `portalGetMatcher` (no verb but `GET` —
  a request whose method the archive dropped, as every Recorder capture's
  is, still matches), so a built URL is one exactly one kind recognizes
  (`portal-url.test.ts` pins that).
- The payload schemas, exported for a producer to type its bodies as their
  `.Encoded`: `CustomerPayload` and `SourcePatient` (the customers body and one
  managed person), `SourcePrescription` and `SourceDispense` (the status body
  and one of its dispenses), `HistoryPayload` and `SourceHistoryDispense` (the
  history body and one entry). Lenient: only the ids each kind keys by are
  required, and every optional field reads `null` as absent. Each list
  (`patients`, both `dispenses`) is a `DecodableEntries`, decoded entry by
  entry: an entry that does not decode (a `quantityDispensed` sent as a
  string, an entry that is not an object, a person with no string `id`) is
  counted rather than failing the payload, so one bad entry never costs its
  siblings or a prescription's `MedicationRequest`. The kinds drop-and-count
  those, and a decoded dispense with no `dispenseId`, in one `Effect.logInfo`.
  The customers feed goes further: every field but the ids is
  `MalformedAsAbsent`, so a person with an `id` is kept even when, say, their
  `phoneNumber` is a number; only the malformed field is lost.
- `src/lenient-schemas.ts` — `DecodableEntries` (a list decoded entry by
  entry, to the entries that decoded plus a count of those that did not) and
  `MalformedAsAbsent` (an optional field that reads `null` or a value that
  does not decode as absent). Both type their encoded side as the inner
  schema's `Encoded`, so a payload's `.Encoded` stays the shape a producer
  writes; that side is declared, not checked, since the inner decode checks
  it.
- `src/shoppers.ts` — the identifier/coding-system URL catalogue
  (`ShoppersIdentifierSystem`, `PRESCRIPTION_STATUS_TYPE_SYSTEM`). There is no
  Shoppers DIN system — DINs use the canonical `CanadianCodingSystem.Din`.
- `src/source-system.ts` — `SHOPPERS_DRUGMART_SYSTEM`, the Wildflower-minted
  `sid` URI each kind's `tryRecognize` mints and adoption keys under.
- `src/dates.ts` — `decodesAsDateTime` / `firstDateTime` date-validation helpers
  shared across entities.
- `src/response-kinds.ts` — `shoppersDrugMartResponseKinds` (internal, the
  descriptor's `responseKinds`): the three kinds widened to
  `HttpResponseKind<FhirResource>` and mapped through `adoptUnderRecognizedRoot`.
  A module-level constant, stable by identity.
- `src/merge-resources.ts` — `mergeShoppersResources`, the source's
  `mergeResources`: a fill seen in both prescription feeds, as one
  `MedicationDispense` (see [Traps](#traps)).
- `src/source.ts` — `shoppersDrugMartSource`, the package's primary export: the
  `SourceDescriptor` (`name: 'shoppers-drugmart'`, display strings, the
  pre-adopted `responseKinds`, and `mergeShoppersResources`).

## Layering

Pure like a `-core`: no DOM, no `fs`, no React. Depends on
`http-extraction-fundamentals` (`HttpResponseKind`, `UrlMatch`, `Specificity`,
`RecognizedUrlData`), `fhir-r4` (resources), `fhir-r4-adoption`
(`adoptUnderRecognizedRoot`), `effect`, and `kitchen-sink` — nothing else. In
particular it must **never** import anything from `slices/importer` (whose
`har-importer-core` consumes this package's
`shoppersDrugMartSource.responseKinds`).

## Conventional slots

What a synthesized resource carries where, so one reader covers this source
and `rexall-be-well-source` alike:

- **Subject** — a status-feed `MedicationRequest` or `MedicationDispense` names
  the managed **person** (`Patient/<patientId>`). A history-feed
  `MedicationDispense` names the **account** by an identifier-only reference,
  the URL's `customerId` under `ShoppersIdentifierSystem.CustomerId`, with no
  literal `reference`: the history payload does not say which managed person
  a fill was for, and no Patient stands for the account. The identifier is
  there for the importer's identity map to resolve to a person; adoption
  leaves it as it is.
- **Prescriber** — a status-feed `MedicationRequest.requester` is
  `fhir-r4`'s `Practitioner.tryReferenceWireFromName` of `prescriberName`,
  since the portal knows the prescriber only by that name: a logical
  reference stating `type` Practitioner, the name identifier (under the
  shared `Practitioner.NAME_IDENTIFIER_SYSTEM`) and the name as printed in
  `display`. Every source names such a provider through that one helper (the
  Rexall prescriber, the DICOM referring physician), so the same name from
  two sources is one referent. A blank or absent name writes no `requester`.
- **DIN** — one coding on `medicationCodeableConcept` under `fhir-r4`'s
  canonical `CanadianCodingSystem.Din`
  (`http://hl7.org/fhir/NamingSystem/ca-hc-din`). The portal does not namespace
  DINs, so no vendor DIN system is minted beside it.
- **Store link** — the public store-locator URL (`shoppers.ts`'s
  `shoppersStoreLocatorUrl`) as a literal `reference` on
  `MedicationRequest.dispenseRequest.performer`, and on
  `MedicationDispense.location` for every dispense (the status feed's and the
  history feed's alike) — never on `supportingInformation`. Its `display` is
  the history feed's store name where there is one, else
  `Shoppers Drug Mart (store <id>)` (`shoppersStoreDisplay`). A request whose
  payload carries a store but nothing else for `dispenseRequest` still gets a
  `dispenseRequest` holding just the `performer`.
- **Status** — `MedicationRequest.status` is `stopped` for a prescription
  the portal flags `expired` or `archived`, else `active`. The portal's own
  `status.type` and label ride `statusReason`, and never change the status.
- **Supply per fill** — `MedicationRequest.dispenseRequest.expectedSupplyDuration`
  in UCUM days (`unit: 'day'`, `system: http://unitsofmeasure.org`,
  `code: 'd'`), as `rexall-be-well-source` states it: the whole days from
  `lastFillDate` to `nextFillDate`. With `dispenseRequest.quantity` (the
  `refillQuantity`, unitless) it is what `medication-core` amortizes a daily
  dose from, since the dose is otherwise only the sig in
  `dosageInstruction[0].text`. It is omitted unless both dates parse and the
  next fill is at least a day after the last, so a prescription the portal
  names no next fill for states no supply.

## Traps

- **A prescription's latest fill is in both feeds under one `dispenseId`,**
  so under one adopted id, and each copy knows something the other does not.
  `mergeShoppersResources` makes them one: the status copy's `subject`,
  `status`, `authorizingPrescription` and `location.reference`, with the
  history copy's store name as `location.display`, and its DIN coding when the
  status copy has none. It tells the copies apart by the history copy's
  `subject`, which has no literal `reference`, so the result is the same in
  either arrival order. Only a consumer that holds both copies applies it (the HAR
  import).
- **`responseKinds` order is not load-bearing, and should stay that way.** The
  three recognizers are disjoint by construction (different path segments:
  `customers/pcid/<uuid>`, `prescriptions/<uuid>/prescription-status`,
  `prescription-history?customerId=…`), so specificity-based routing never
  reaches the tie-breaking list order.
- **Each recognizer is an exact, anchored full-URL regex.** The host
  (`mypharmacy.shoppersdrugmart.ca`), the `v1` version segment, and the whole
  path are pinned — no prefix or suffix segment (nor a bare trailing slash) is
  tolerated, only the `<uuid>` path parameter and the query vary. This is
  deliberately stricter than the earlier version-agnostic `/api/<anything>/…`
  matchers: an old `/api/p1/…` capture would no longer match.

## References

- [slices/http-extraction/AGENTS.md](../AGENTS.md) — the slice this package
  belongs to.
- [http-extraction-fundamentals AGENTS.md](../http-extraction-fundamentals/AGENTS.md)
  — the vocabulary this package is written against.
- [har-importer-core AGENTS.md](../../importer/har-importer-core/AGENTS.md)
  — the archive importer that runs these kinds.
- [Source Identity Explanation](../fhir-r4-adoption/docs/Source%20Identity%20Explanation.md)
  — why a resource is re-keyed under a derived local id.
