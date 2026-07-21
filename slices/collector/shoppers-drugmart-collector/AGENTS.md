# AGENTS.md — slices/collector/shoppers-drugmart-collector

The **Shoppers Drug Mart collector**: logs into the Shoppers "mypharmacy"
portal (`mypharmacy.shoppersdrugmart.ca`, via the shared `accounts.pcid.ca`
login), **pauses for the user's 2FA**, and pulls their prescriptions into the
on-device FHIR **R4** store. Unlike `rexall-be-well-collector` (whose tunnel API
serves FHIR STU3 the `fhir-stu3-as-r4` slice decodes), the Shoppers portal serves
**bespoke, non-FHIR JSON**; this package **synthesizes** R4 resources from it
directly with the `fhir-r4` schemas. Independent of the Rexall collector — it
shares no code with it (the persist sink and JSON extractor are verbatim copies,
per slice layering).

## The collector

Mirrors `fhir-r4-client-collector`; wired into `collector-registry` +
`collector-react`:

- `src/config.ts` — `InstanceConfig` (`{ _tag: 'shoppers-drugmart', email,
password }`) with fast-check arbitraries, `defaultConfig`, the
  login-pause-for-2FA-and-list `scrapingPlan`, and the
  `ShoppersDrugMartCollectorDescriptor`.
- `src/entities/profile-entity.ts` — recognizes `…/api/profile/getProfile/` and
  synthesizes an R4 `Patient` from the (non-FHIR) profile JSON, keyed by `pcId`.
- `src/entities/prescription-entity.ts` — recognizes
  `…/api/v1/prescriptions/:uuid/prescription-status` (one XHR **per
  prescription**) and synthesizes, from each response, a minimal `Patient`
  (keyed by `patientId`), one `MedicationRequest`, and one `MedicationDispense`
  per `dispenses` entry.
- `src/shoppers.ts` — the identifier/coding-system URL catalogue.
- `src/persist.ts` — the write sink (a verbatim copy of
  `fhir-r4-client-collector/src/persist.ts`; slice layering forbids importing it).
- `src/extract-json.ts` — XHR/JSON-viewer body normalizer (also copied).
- `src/shoppers-drugmart-config-form.tsx` (+ `.module.css`) — the email/password
  `ConfigFormProps` form `collector-react` registers.
- `src/index.ts` — the barrel.

Only user-facing portal pages are ever navigated (the login page, then the
prescription dashboard); the collector only **sniffs** the XHRs those pages fire.
No API URL is ever crafted or opened directly.

## The login + 2FA flow

The plan's `stepSequence`:

1. Mounts `…/en/login`, then **`AwaitPageSettled` on the `accounts.pcid.ca/login`
   redirect** before filling — filling before the cross-host redirect lands would
   target the wrong DOM.
2. Fills `input[type="email"]` / `input[type="password"]`, clicks
   `button[type="submit"]`.
3. **`AwaitPageSettled` on `…/en/healthdashboard/` with a 5-minute timeout** —
   this is the human-in-the-loop 2FA pause. The dashboard only loads once the
   user completes verification on `accounts.pcid.ca/login/verification`; its
   `…/api/profile/getProfile/` XHR is sniffed as the dashboard settles.
4. `Open`s the prescription dashboard, `AwaitPageSettled` on it, then a trailing
   `Delay` for the per-prescription `prescription-status` XHR fan-out.

## pcId ≠ patientId (two Patient records, by design)

The profile's `pcId` and a prescription's `patientId` are **different
identifiers for the same person** and do **not** align (confirmed against
production). Collector entities parse each XHR **independently** — there is no
shared state and no join key between the two ids — so the collector emits **two
Patient records**:

- a **demographic** `Patient` keyed by `pcId` (from `getProfile`: name, DOB,
  email/phone telecom, postal address), and
- a **minimal** `Patient` keyed by `patientId` (from each prescription), which is
  the id `MedicationRequest.subject` / `MedicationDispense.subject` resolve to.

Each carries its own id as a FHIR `identifier` (distinct systems in
`shoppers.ts`) so the two can be reconciled downstream. Keying the demographic
Patient by `patientId` isn't possible here (the profile payload never carries
`patientId`), and keying the subject by `pcId` isn't either (the prescription
payload never carries `pcId`).

## Resource mapping notes

- **`MedicationRequest.status` is always `'unknown'`** — the portal `status` is a
  free-text label (`"Unable to renew online"`), not a FHIR code. The label is
  preserved in `statusReason.text` and its longer `labelDescription` in a `note`,
  so nothing is lost and no clinical state is asserted.
- **Dates are validated before use** (`decodesAsDateTime`), so a malformed
  date drops just that slot rather than failing the whole resource decode.
- **The fill window is `dispenseRequest.validityPeriod`** — `lastFillDate` opens
  it (`start`), `nextFillDate` closes it (`end`), with the prescription
  `expiryDate` as the `end` fallback when no `nextFillDate` is present. Only one
  of `lastFillDate` / `nextFillDate` is ever observed, and whichever is present
  also authors the request (`authoredOn`, preferring `lastFillDate`).
- **The dispensing `storeId` becomes a `supportingInformation` reference** to the
  public store-locator URL (`…/store-locator/store/:id`, built from
  `SHOPPERS_STORE_LOCATOR_BASE`). The medication-sponsorship UI shows a "Shoppers"
  store button by prefix-matching that same base — keep the two constants in sync.
- A **dispense with no `dispenseId`** has no logical id to write under, so it is
  dropped-and-counted (`Effect.logInfo`) rather than silently skipped at the sink.

## Fixtures & open questions caveat

The entity schemas are **synthesized from the ticket's notes, not real captured
payloads**. Reconcile against redacted real captures before relying on the
collector end-to-end:

- **Login-form selectors / submit button** — `config.ts`'s `SUBMIT_SELECTOR` is a
  best-guess standard submit button; the email/password selectors are the ones
  the ticket specified.
- **`dispenses` shape** — real captures wrap each dispense in a numeric-keyed
  object (`[{ "0": { … } }]`); `flattenDispenses` tolerates both that and a flat
  array, but the exact shape should be confirmed.
- **Endpoint URLs / trailing slashes** — `getProfile` carries a trailing slash;
  the recognizers are hand-rolled regexes (not `UrlMatch.make`) to tolerate it.
- **System URIs** (`shoppers.ts`) — best-guess namespaces; the canonical Health
  Canada / Infoway DIN system URI in particular should be reconciled.

## References

- [Adding a Collector How-To](../docs/Adding%20a%20Collector%20How-To.md) — the
  recipe this collector follows
- [fhir-r4-client-collector](../fhir-r4-client-collector) — the worked example mirrored
- [rexall-be-well-collector](../rexall-be-well-collector) — the sibling credential
  collector (STU3 dialect; this one is direct-R4 synthesis)
- [fhir-r4](../../emr/fhir-r4) — the R4 resource types and the `upsertResource` write path
- [collector-fundamentals](../collector-fundamentals) — the descriptor / entity / plan primitives
