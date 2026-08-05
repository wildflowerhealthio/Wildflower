# AGENTS.md — slices/collector/shoppers-drugmart-collector

The **Shoppers Drug Mart collector**: logs into the Shoppers "mypharmacy"
portal (`mypharmacy.shoppersdrugmart.ca`, via the shared `accounts.pcid.ca`
login), **pauses for the user's 2FA**, and pulls their prescriptions into the
on-device FHIR **R4** store. Unlike `rexall-be-well-collector` (whose tunnel API
serves FHIR STU3 the `fhir-stu3-as-r4` slice decodes), the Shoppers portal serves
**bespoke, non-FHIR JSON**; this package **synthesizes** R4 resources from it
directly with the `fhir-r4` schemas. Independent of the Rexall collector — it
shares no code with it. The write sink is `fhir-r4/clients`' shared
`persistResources` (the same one every FHIR collector uses); the JSON extractor
is a verbatim copy, per slice layering.

Like every other importer, the plan is wrapped in `adoptSourceIdentity` so its
resources are re-keyed under derived local ids — see
[account vs patient records](#account-vs-patient-records) and the
[Source Identity Explanation](../docs/Source%20Identity%20Explanation.md).

## The endpoints (version-agnostic)

The capture shows an `/api/p1/…` version segment while the portal is documented
elsewhere as `/api/v1/…` — the two disagree, so **every recognizer matches
`/api/<anything>/…`** (`/api/[^/]+/…`), never a literal `p1`/`v1`. The four real
XHRs the collector cares about, and which page fires each:

- `GET …/api/<seg>/customers/:uuid?expand=…` — the account and the people it
  manages. Fired by the health dashboard **and** the prescription-history page.
  → `CustomerEntity`.
- `GET …/api/<seg>/prescriptions/:uuid/prescription-status` — one **per
  prescription**, fired by the prescription-dashboard page. → `PrescriptionEntity`.
- `GET …/api/<seg>/prescription-history?customerId=…` — **every** dispense across
  all prescriptions (the status endpoint carries at most the latest fill per
  prescription), fired by the prescription-history page. → `PrescriptionHistoryEntity`.
- `…/customers/:uuid/toasts?source=LOGIN` and other sub-paths are **not** claimed
  — the `customers` recognizer anchors the uuid as the final path segment.

The three recognizers are **disjoint by construction** (different path segments),
so `entityDefinitions` order is not load-bearing.

## The collector

Mirrors `fhir-r4-client-collector`; wired into `collector-registry` +
`collector-react`:

- `src/config.ts` — `InstanceConfig` (`{ _tag: 'shoppers-drugmart', email,
password }`) with fast-check arbitraries, `defaultConfig`, the
  login-pause-for-2FA-then-visit-dashboard-and-history `scrapingPlan`, and the
  `ShoppersDrugMartCollectorDescriptor`.
- `src/entities/customer-entity.ts` — recognizes `…/customers/<uuid>` and
  synthesizes, from the account payload, one demographic `Patient` per managed
  person (keyed by `patients[].id`) plus a linked account `Patient` (keyed by
  `pcid`).
- `src/entities/prescription-entity.ts` — recognizes
  `…/prescriptions/:uuid/prescription-status` (one XHR per prescription) and
  synthesizes one `MedicationRequest` and one `MedicationDispense` per
  `dispenses` entry. No Patient (the subject records come from `CustomerEntity`).
- `src/entities/prescription-history-entity.ts` — recognizes
  `…/prescription-history?customerId=…` and synthesizes one `MedicationDispense`
  per history entry (no Patient, no MedicationRequest).
- `src/entities/medication-wire.ts` — the `medicationCodeableConcept` builder
  (brand/chemical text + DIN coding) shared by the two dispense-emitting entities;
  the DIN is per-payload (fills of one rx can differ).
- `src/dates.ts` — the `decodesAsDateTime` / `firstDateTime` date-validation
  helpers shared across entities.
- `src/shoppers.ts` — the identifier/coding-system URL catalogue
  (`ShoppersIdentifierSystem`, `DIN_CODE_SYSTEM`, `PRESCRIPTION_STATUS_TYPE_SYSTEM`),
  plus `SHOPPERS_DRUGMART_SYSTEM` (in `config.ts`) — the Wildflower-minted `sid`
  URI the plan adopts under, mirroring Rexall's `REXALL_CAREBOOK_SYSTEM`.
- the write sink — `fhir-r4/clients`' shared `persistResources`, imported in
  `config.ts` and handed straight to the descriptor (no per-collector copy).
- `src/extract-json.ts` — XHR/JSON-viewer body normalizer (a verbatim copy, per
  slice layering).
- `src/shoppers-drugmart-config-form.tsx` (+ `.module.css`) — the email/password
  `ConfigFormProps` form `collector-react` registers.
- `src/index.ts` — the barrel.

Only user-facing portal pages are ever navigated (login → health dashboard →
prescription dashboard → prescription history); the collector only **sniffs** the
XHRs those pages fire. No API URL is ever crafted or opened directly.

## The login + 2FA flow

The plan's `stepSequence`:

1. Mounts `…/en/login`, then **`AwaitPageSettled` on the `accounts.pcid.ca/login`
   redirect** before filling — filling before the cross-host redirect lands would
   target the wrong DOM.
2. Fills `input[type="email"]` / `input[type="password"]`, clicks
   `button[type="submit"]`.
3. **`AwaitPageRequested` on `…/en/healthdashboard/` with a 5-minute timeout** —
   this is the human-in-the-loop 2FA pause. The dashboard only loads once the
   user completes verification on `accounts.pcid.ca/login/verification`. Arrival
   (`DOMContentLoaded`), not settlement, on purpose: the dashboard keeps loading
   past the sniffer's settle detector, so an `AwaitPageSettled` here sat parked
   with the page visibly up until its timeout.
4. `Open`s the prescription dashboard, `AwaitPageSettled` on it, then a `Delay`
   for the per-prescription `prescription-status` XHR fan-out.
5. `Open`s the prescription-history page, `AwaitPageSettled` on it, then a
   trailing `Delay` — one visit fires both the `prescription-history` and
   `customers` XHRs (full dispense history + the account and its managed people).

## Account vs patient records

The account's `pcid` (`== customer.id ==` the `customerId` query param) and a
managed person's `patientId` (a `customer.patients[].id`) are **different kinds
of id** — an account vs a person — but the relationship is **known and joinable**:
the customers payload carries both together. So `CustomerEntity` emits:

- a **demographic** `Patient` per `customer.patients[]` entry, keyed by its `id`
  (name, phone telecom, address) — the record `MedicationRequest.subject` /
  `MedicationDispense.subject` resolve to, and
- an **account** `Patient` keyed by `customer.pcid` (account name, email, phone,
  address) carrying a `link.seealso` to each demographic Patient.

Each carries its own id as a FHIR `identifier` (distinct systems in
`shoppers.ts`). `adoptSourceIdentity` re-keys each Patient under
`localResourceId(SHOPPERS_DRUGMART_SYSTEM, 'Patient', <original id>)` — the account
and each person get **distinct** derived ids (the original id is an input to the
derivation) — and rewrites the `link.seealso` relative reference onto the
demographic Patient's derived id, so the join is **materialized** in the store and
lands on the same id `subject` resolves to.

**`PrescriptionEntity` no longer emits a subject Patient.** `CustomerEntity` owns
those records, and the same run always visits a page that fires the customers XHR.
The trade-off (documented in the entity): a run where the customers XHR fails
leaves the prescriptions' `subject` references dangling, which the store tolerates
(references are not FK-enforced).

## Resource mapping notes

- **`MedicationRequest.status`** is `'stopped'` when the payload's top-level
  `expired` or `archived` flag is set, and `'unknown'` otherwise — deliberately
  conservative (nothing maps to `'active'`; the portal enum asserts a
  renewal/refill affordance, not clinical activity).
- **`statusReason`** carries the portal's machine `status.type` as a coding under
  `PRESCRIPTION_STATUS_TYPE_SYSTEM` (an **open** code set — `READY_FOR_RENEW`,
  `UNABLE_TO_RENEW_ONLINE`, `READY_FOR_REFILL_NO_DISPENSE`, …) plus the human
  label as `text`; the longer `labelDescription` rides a `note`.
- **`priorPrescription`** is an **identifier-only** reference built from
  `previousPrescription` (the prior rx's human number) — we don't know its uuid,
  and adoption leaves an identifier-only reference untouched.
- **Dates are validated before use** (`decodesAsDateTime`), so a malformed date
  drops just that slot rather than failing the whole resource decode. The portal
  uses date-only strings (`YYYY-MM-DD`), which decode as midnight UTC.
- **The fill window is `dispenseRequest.validityPeriod`** — `lastFillDate` opens
  it (`start`), `nextFillDate` closes it (`end`), with the prescription
  `expiryDate` as the `end` fallback. Only one of `lastFillDate` / `nextFillDate`
  is ever present, and whichever it is also authors the request (`authoredOn`).
- **The dispensing store becomes a store-locator reference** to the public
  `…/store-locator/store/:id` URL (`SHOPPERS_STORE_LOCATOR_BASE`) — on
  `MedicationRequest.supportingInformation` (from the status `storeId`) and on
  `MedicationDispense.location` (from the history `store.id`, with `store.storeName`
  as `display`). Absolute URLs, so adoption leaves them untouched. The
  medication-sponsorship UI prefix-matches that same base — keep the constants in
  sync.
- **History dispenses** get `status: 'completed'` (history entries are completed
  fills; the payload has no status field to say otherwise) and **no `subject`**
  (the history payload carries no `patientId`, and `MedicationDispense.subject` is
  0..1 in R4). They link to their request via `authorizingPrescription` (a
  relative `MedicationRequest/<prescriptionId>` reference carrying the human
  `prescriptionNumber` as the reference's own `identifier`).
- **Status/history dispense overlap.** The latest fill of a prescription appears
  in both the status feed and the history feed; same `dispenseId` → same adopted
  id → an idempotent upsert. The history version is strictly richer, and write
  ordering within a run is not guaranteed, so last-write-wins on the shared id is
  acceptable.
- A **dispense with no `dispenseId`** (and a **patient with no `id`**) has no
  logical id to write under, so it is dropped-and-counted (`Effect.logInfo`)
  rather than silently skipped at the sink.

## Fixtures & open questions caveat

The entity schemas are **reconciled against a redacted real capture** of the
portal (a `web-trace` HAR that exists in `.local-notes/`, kept out of the repo).
Fixtures are hand-written with the same shapes and obviously-fake values — no
decoded body is committed. Remaining unknowns:

- **Login-form selectors / submit button** — the login/health-dashboard segment
  was **not** captured, so `config.ts`'s selectors are unchanged best-guesses;
  reconcile against the real DOM.
- **`p1` vs `v1` API version segment** — the HAR shows `p1`, the endpoint is
  documented as `v1`; recognizers are version-agnostic on purpose.
- **System URIs** (`shoppers.ts`) — best-guess namespaces under the portal host;
  the canonical Health Canada / Infoway DIN system URI in particular should be
  reconciled.

## References

- [Adding a Collector How-To](../docs/Adding%20a%20Collector%20How-To.md) — the
  recipe this collector follows
- [fhir-r4-client-collector](../fhir-r4-client-collector) — the worked example mirrored
- [rexall-be-well-collector](../rexall-be-well-collector) — the sibling credential
  collector (STU3 dialect; this one is direct-R4 synthesis)
- [fhir-r4](../../emr/fhir-r4) — the R4 resource types and the `upsertResource` write path
- [collector-fundamentals](../collector-fundamentals) — the descriptor / entity / plan primitives
