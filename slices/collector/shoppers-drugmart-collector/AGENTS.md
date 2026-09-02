# AGENTS.md — slices/collector/shoppers-drugmart-collector

The **Shoppers Drug Mart collector**: logs into the Shoppers "mypharmacy"
portal (`mypharmacy.shoppersdrugmart.ca`, via the shared `accounts.pcid.ca`
login), **pauses for the user's 2FA**, and pulls their prescriptions into the
on-device FHIR **R4** store. Unlike `rexall-be-well-collector` (whose tunnel API
serves FHIR STU3 the `fhir-stu3-as-r4` slice decodes), the Shoppers portal serves
**bespoke, non-FHIR JSON**; the source package (`shoppers-drugmart-source` in
`slices/http-extraction/`) **synthesizes** R4 resources from it directly with the
`fhir-r4` schemas — this collector layers navigation and persistence on top.
Independent of the Rexall collector — it shares no code with it. The write sink
is `fhir-r4/clients`' shared `persistResources` (the same one every FHIR
collector uses).

Like every other FHIR-family collector, its resources are re-keyed under derived
local ids: `SHOPPERS_DRUGMART_SYSTEM` rides each kind's own `tryRecognize` as
`source: { system: SHOPPERS_DRUGMART_SYSTEM }` (no `baseUrl`), and the kind list
is mapped through `adoptUnderRecognizedRoot` once at module scope in
`shoppers-drugmart-source`'s `response-kinds.ts` — see
[account vs patient records](#account-vs-patient-records) and the
[Source Identity Explanation](../docs/Source%20Identity%20Explanation.md).

## The endpoints (version-agnostic)

The capture shows an `/api/p1/…` version segment while the portal is documented
elsewhere as `/api/v1/…` — the two disagree, so **every recognizer matches
`/api/<anything>/…`** (`/api/[^/]+/…`), never a literal `p1`/`v1`. The four real
XHRs the collector cares about, and which page fires each:

- `GET …/api/<seg>/customers/:uuid?expand=…` — the account and the people it
  manages. Fired by the health dashboard **and** the prescription-history page.
  → `CustomerResponseKind`.
- `GET …/api/<seg>/prescriptions/:uuid/prescription-status` — one **per
  prescription**, fired by the prescription-dashboard page. → `PrescriptionResponseKind`.
- `GET …/api/<seg>/prescription-history?customerId=…` — **every** dispense across
  all prescriptions (the status endpoint carries at most the latest fill per
  prescription), fired by the prescription-history page. → `PrescriptionHistoryResponseKind`.
- `…/customers/:uuid/toasts?source=LOGIN` and other sub-paths are **not** claimed
  — the `customers` recognizer anchors the uuid as the final path segment.

The three recognizers are **disjoint by construction** (different path segments),
so `responseKinds` order is not load-bearing. The response kinds themselves live
in `shoppers-drugmart-source` — see its
[AGENTS.md](../../http-extraction/shoppers-drugmart-source/AGENTS.md) for the
entity shapes, resource mapping notes, and coding-system catalogue.

## The collector

Mirrors `fhir-r4-client-collector`; wired into `collector-registry` +
`collector-react`:

- `src/config.ts` — `InstanceConfig` (`{ _tag: 'shoppers-drugmart', email,
password }`) with fast-check arbitraries, `defaultConfig`, the
  login-pause-for-2FA-then-visit-dashboard-and-history `scrapingPlan`, and the
  `ShoppersDrugMartCollectorDescriptor`.
- the write sink — `fhir-r4/clients`' shared `persistResources`, imported in
  `config.ts` and handed straight to the descriptor (no per-collector copy).
- provenance — the plan-level `captureProvenance` hook
  (`web-trace-core`'s `makeFhirProvenanceCapture('shoppers-drugmart')`), so every
  portal response an entity synthesized from is stored verbatim as a trace
  `DocumentReference`. It matters more here than for a FHIR source: these
  resources are **synthesized** against a hand-reconciled schema, so the raw
  payload is the only way to check a mapping after the fact.
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

**Both trailing `AwaitPageSettled` holds set `continueOnTimeout: true`, and that
is load-bearing.** They wait on the same SPA shell step 3 already concluded never
satisfies the settle detector. The sniffer arms its settle watch only from
`window.load`, so a shell whose `load` never fires never settles and never
reaches the detector's own hard ceiling either — an aborting hold would therefore
kill the run 30 seconds after the user finished a 5-minute 2FA interaction, with
the XHRs quite possibly already sniffed. Advancing into the trailing `Delay`
keeps whatever was captured.

**Known residual risk:** both holds are pattern-less, so _any_ settled load
releases them — including a late settle belonging to the previous page, which was
still the current document when the `Open` was dispatched. That would start the
trailing `Delay` against the wrong page and cut the fan-out short. Closing it
means asserting a URL pattern for a page whose settle behaviour has not been
characterised, so it is deferred until the portal's real behaviour is observed.

## Account vs patient records

The account's `pcid` (`== customer.id ==` the `customerId` query param) and a
managed person's `patientId` (a `customer.patients[].id`) are **different kinds
of id** — an account vs a person — but the relationship is **known and joinable**:
the customers payload carries both together. So `CustomerResponseKind` emits:

- a **demographic** `Patient` per `customer.patients[]` entry, keyed by its `id`
  (name, phone telecom, address) — the record `MedicationRequest.subject` /
  `MedicationDispense.subject` resolve to, and
- an **account** `Patient` keyed by `customer.pcid` (account name, email, phone,
  address) carrying a `link.seealso` to each demographic Patient.

Each carries its own id as a FHIR `identifier` (distinct systems in
`shoppers.ts`). `adoptUnderRecognizedRoot` re-keys each Patient under
`localResourceId(SHOPPERS_DRUGMART_SYSTEM, 'Patient', <original id>)` — the account
and each person get **distinct** derived ids (the original id is an input to the
derivation) — and rewrites the `link.seealso` relative reference onto the
demographic Patient's derived id, so the join is **materialized** in the store and
lands on the same id `subject` resolves to.

**`PrescriptionResponseKind` no longer emits a subject Patient.** `CustomerResponseKind` owns
those records, and the same run always visits a page that fires the customers XHR.
The trade-off (documented in the entity): a run where the customers XHR fails
leaves the prescriptions' `subject` references dangling, which the store tolerates
(references are not FK-enforced).

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

- [shoppers-drugmart-source AGENTS.md](../../http-extraction/shoppers-drugmart-source/AGENTS.md)
  — the response kinds and resource mapping this collector consumes
- [Adding a Collector How-To](../docs/Adding%20a%20Collector%20How-To.md) — the
  recipe this collector follows
- [fhir-r4-client-collector](../fhir-r4-client-collector) — the worked example mirrored
- [rexall-be-well-collector](../rexall-be-well-collector) — the sibling credential
  collector (STU3 dialect; this one is direct-R4 synthesis)
- [fhir-r4](../../emr/fhir-r4) — the R4 resource types and the `upsertResource` write path
- [collector-fundamentals](../collector-fundamentals) — the descriptor / entity / plan primitives
