# AGENTS.md — slices/collector/lifelabs-collector

The **LifeLabs collector**: logs into LifeLabs' `myvisit.lifelabs.com` portal and
pulls the user's lab results into the on-device FHIR **R4** store. Results come
from the MyCareCompass analytics page's `GetAnalyticSummary` XHR
(`on-api.mycarecompass.lifelabs.com/api/Report/GetAnalyticSummary`), a **bespoke,
non-FHIR JSON** payload. This package holds everything LifeLabs-specific, from the
login/analytics scraping plan up to the registered `CollectorDescriptor`.

Mirrors `rexall-be-well-collector`, but **simpler**: LifeLabs serves its own JSON
shape rather than FHIR, so there is **no STU3/carebook dialect layer** — the
entity synthesizes R4 resources straight from the payload, depending on `fhir-r4`
(not `fhir-stu3-as-r4`).

## The collector

- `src/config.ts` — `InstanceConfig` (`{ _tag: 'lifelabs', username, password }`)
  with fast-check arbitraries, `defaultConfig`, the **captcha-aware**
  login-and-analytics `scrapingPlan`, and the `LifeLabsCollectorDescriptor`.
- `src/entities/analytic-summary-entity.ts` — recognizes
  `…/api/Report/GetAnalyticSummary` and, from that one bespoke JSON response,
  synthesizes an R4 `Patient` (`id = entity.selectedPatient`) plus one
  `Observation` per `entity.analytics[]` row. Analytics with no `testCode` /
  `testItemId` to key a stable id are dropped-and-counted.
- `src/persist.ts` — the write sink (a verbatim copy of
  `fhir-r4-client-collector/src/persist.ts`; slice layering forbids importing it).
- `src/extract-json.ts` — XHR/JSON-viewer body normalizer (also copied).
- `src/lifelabs-config-form.tsx` (+ `.module.css`) — the username/password
  `ConfigFormProps` form `collector-react` registers.
- `src/index.ts` — the barrel.

Only user-facing LifeLabs pages are ever navigated (the myVisit login page, then
the MyCareCompass analytics page); the collector only **sniffs** the XHRs those
pages fire. **No API host (`on-api.mycarecompass.lifelabs.com`) is ever crafted
or opened directly** — those requests need auth headers the SPA injects, and
crafting them is an explicit product constraint (mirrors the Rexall tunnel
constraint).

## The captcha: no submit click

The myVisit login page carries a **CAPTCHA**, so the plan cannot auto-submit. It
`Fill`s the username and password, then holds on an `AwaitPageSettled` for the
post-login `myvisit.lifelabs.com` dashboard — which only settles once the **user**
has solved the captcha and clicked Login themselves. The hold has a generous
`LOGIN_TIMEOUT` (minutes, not seconds) to span the manual step. No new step
primitive is needed: the existing `Fill` + `AwaitPageSettled` model expresses
"autofill, then wait for the human" directly.

## Mapping `analytics[]` → `Observation`

- `status` = `final` (posted results).
- `code.text` = `testItemName` (the analyte, e.g. "WBC"), plus a supplementary
  coding `{ system: LIFELABS_TEST_SYSTEM, code: testCode, display: testName }`.
- `subject` = `Patient/{selectedPatient}`.
- `effectiveDateTime` = the .NET `/Date(ms±hhmm)/` `collectionDate` parsed to ISO
  UTC (the trailing offset is display-only; the millis are absolute UTC).
- value: a numeric `testResultValue` → `valueQuantity` (no unit is present in the
  source), anything else → `valueString`.
- `referenceRange` = the raw string as `text`, plus parsed `low`/`high` when it is
  a simple numeric interval (`4.0 - 11.0`, `120- 160`).
- `interpretation` = `abnormalFlag` when present.
- logical id = sanitized `testItemId` (base64 → FHIR-safe token) suffixed with the
  collection millis, so repeat draws of the same analyte across dates don't
  collide.

## Fixtures & open questions caveat

`src/fixtures/analytic-summary.json` is **synthesized from the ticket's payload
notes, not a real captured payload** (redacted patient/name, shortened test list).
Validate it — and reconcile these **open questions** — against a redacted real
capture before relying on the collector end-to-end:

- **Login-form selectors** — `config.ts`'s `USERNAME_SELECTOR` /
  `PASSWORD_SELECTOR` are best-guess defaults for `myvisit.lifelabs.com/login`. A
  wrong guess degrades to a manual login (the user types the field), not a build
  failure — the captcha already puts the user in the loop.
- **Login transition** — the `AwaitPageSettled` on `myvisit.lifelabs.com/` assumes
  the post-login jump surfaces a settled `PageLoaded` (a hard navigation, or an
  SPA route the sniffer's settle watch still reports). The sniffer reports only
  hard navigations; if myVisit's post-login redirect is a client-side route, this
  needs the `history.pushState` sniffer fallback noted on Rexall issue #339.
- **Cross-domain session** — opening `www.on.mycarecompass.lifelabs.com/analytics`
  after a `myvisit.lifelabs.com` login assumes a shared/SSO session carries over.
  Verify against a real account.
- **Province** — the analytics/API hosts are Ontario-specific (`on.` / `on-api.`).
  Other provinces are a follow-up (parameterize the host from a `province` config
  field).
- **Value units & result types** — the payload carries no unit and mixes numeric
  results with free-text notes; confirm the `valueQuantity`-vs-`valueString` split
  against real data (and whether a units source exists).

## References

- [Adding a Collector How-To](../docs/Adding%20a%20Collector%20How-To.md) — the
  recipe this collector follows
- [rexall-be-well-collector](../rexall-be-well-collector) — the sibling this
  mirrors (with a STU3 dialect layer this one doesn't need)
- [fhir-r4-client-collector](../fhir-r4-client-collector) — the worked example
- [fhir-r4](../../emr/fhir-r4) — the R4 `Observation` / `Patient` types and the
  `upsertResource` write path
- [collector-fundamentals](../collector-fundamentals) — the descriptor / entity /
  plan primitives
