# AGENTS.md — slices/collector/rexall-be-well-collector

The **Rexall Be Well collector**: logs into Rexall's `letsbewell.ca` portal and
pulls the user's prescriptions into the on-device FHIR **R4** store. The Rexall
tunnel API (`rexall-prd-tunnel.letsbewell.ca/enduser/health/v1/fhir/stu3/…`)
serves FHIR **STU3** searchset Bundles in a narrow, extension-heavy carebook
dialect; this package holds everything Rexall/carebook-specific, from the dialect
constants up to the registered `CollectorDescriptor`. The generic STU3⇄R4 schema
machinery lives in `slices/emr/fhir-stu3-as-r4`.

## Two layers

**1. carebook dialect** (the original scope of this package):

- `src/carebook.ts` — the dialect catalogue: carebook extension URLs, identifier
  systems, and the DIN coding system.
- `src/bundle.ts` — the concrete carebook searchset Bundles (`MedicationRequestBundle`,
  `MedicationDispenseBundle`, mixed `MedicationBundle`), built by feeding the
  `fhir-stu3-as-r4/schemas` resource schemas through that slice's generic
  `Bundle.searchsetBundle` factory.

**2. the collector** (mirrors `fhir-r4-client-collector`; wired into
`collector-registry` + `collector-react`):

- `src/config.ts` — `InstanceConfig` (`{ _tag: 'rexall', email, password }`) with
  fast-check arbitraries, `defaultConfig`, the login-and-prescriptions
  `scrapingPlan`, and the `RexallCollectorDescriptor`.
- `src/entities/profile-entity.ts` — recognizes `…/profile/v2/me` and synthesizes
  an R4 `Patient` from the (non-FHIR) carebook profile JSON.
- `src/entities/medication-list-entity.ts` — recognizes the prescriptions page's
  `…/pharmacy/Location?…_revinclude=…` searchset and decodes the **heterogeneous**
  bundle "as is" (a `Schema.Union` of the two carebook `R4FromStu3Schema`
  transforms plus a `null` catch-all for non-medication entries), then splits off
  just `MedicationRequest` / `MedicationDispense`, dropping-and-counting the rest.
- the persist sink — built in `src/config.ts` from `fhir-r4`'s shared
  `makePersistResources`, passing this collector's telemetry names.
- `src/extract-json.ts` — XHR/JSON-viewer body normalizer (also copied).
- `src/rexall-config-form.tsx` (+ `.module.css`) — the email/password
  `ConfigFormProps` form `collector-react` registers.
- `src/index.ts` — the barrel re-exporting both layers.

Only user-facing `letsbewell.ca` pages are ever navigated (the login page, then
the prescriptions page); the collector only **sniffs** the XHRs those pages fire.
**No tunnel/API URL is ever crafted or opened directly** — those requests need
auth/bearer headers the Angular SPA injects, and crafting them is an explicit
product constraint.

## v1 scope: list-only

v1 ships **list-only** — no per-medication detail crawl. The prescriptions-page
searchset's `_revinclude` already carries `MedicationDispense`, so the deferred
`followUpSteps` crawl (one `Open` per `MedicationRequest.id` →
`…/prescriptions/details/{id}`) is left out until a capture diff proves the detail
XHR is richer. Adding it later is a pure, additive `followUpSteps` method on
`MedicationListEntity` — no structural change.

## Fixtures & open questions caveat

The fixtures in `src/fixtures/` and the `carebook.ts` constants are **synthesized
from the epic's dialect notes, not real captured payloads**. `prescriptions-searchset.json`
(the heterogeneous list bundle) and `profile-me.json` (the carebook profile) are
built to the shapes the epic describes. Validate them — and reconcile these
**open questions** — against redacted real captures before relying on the
collector end-to-end:

- **Login-form selectors** — `config.ts`'s `EMAIL_SELECTOR` / `PASSWORD_SELECTOR`
  / `SUBMIT_SELECTOR` are best-guess defaults for `verify.letsbewell.ca/login`.
- **Login transition** — the `AwaitPageSettled` hold after the submit `Click`
  assumes the post-login jump to `app.letsbewell.ca` surfaces a settled
  `PageLoaded` (a hard cross-host redirect, or an SPA route the sniffer's settle
  watch still reports). Falls back to a fixed `Delay` if it bites (see the sniffer
  caveat on issue #339).
- **Profile field names** — reconciled against production: `ProfileEntity`'s
  `ProfileSchema` reads the `/me` payload's top-level `data` envelope
  (`data.identifiers.uid` / `data.identifiers.email` / `data.firstName` /
  `data.lastName` / `data.birthDate` / `data.address.postalCode`), and
  `profile-me.json` mirrors that shape. Decode stays lenient — a field the
  capture omits simply won't populate its Patient slot (it never fails the
  decode).
- **Detail XHR richness** — the list-vs-detail capture diff that decides whether
  the deferred detail crawl is needed at all.

## References

- [Adding a Collector How-To](../docs/Adding%20a%20Collector%20How-To.md) — the
  recipe this collector follows
- [fhir-r4-client-collector](../fhir-r4-client-collector) — the worked example mirrored
- [fhir-stu3-as-r4](../../emr/fhir-stu3-as-r4) — the STU3⇄R4 schemas the bundles decode with
- [fhir-r4](../../emr/fhir-r4) — the R4 resource types and the `upsertResource` write path
- [collector-fundamentals](../collector-fundamentals) — the descriptor / entity / plan primitives
