# AGENTS.md — slices/collector/lifelabs-collector

The **LifeLabs collector**: logs into LifeLabs' MyCareCompass portal
(`www.on.mycarecompass.lifelabs.com`) and pulls the user's lab results into
the on-device FHIR **R4** store. Results
come from the MyCareCompass analytics page's `GetAnalyticSummary` XHR, a
bespoke non-FHIR JSON payload that the source package
([`lifelabs-source`](../../http-extraction/lifelabs-source/AGENTS.md), in
`slices/http-extraction/`) synthesizes an R4 `Patient` plus one `Observation`
per analytic from. This package layers navigation, provenance, and persistence
on top, mirroring `shoppers-drugmart-collector`. The write sink is
`fhir-r4/clients`' shared `persistResources`.

Like every other FHIR-family collector, its resources are re-keyed under
derived local ids: `LIFELABS_SYSTEM` rides the kind's own `tryRecognize` as
`source: { system: LIFELABS_SYSTEM }` (no `baseUrl`), and the kind list is
mapped through `adoptUnderRecognizedRoot` once at module scope in
`lifelabs-source` — see the
[Source Identity Explanation](../docs/Source%20Identity%20Explanation.md).

## Shape

- `src/config.ts` — `InstanceConfig` (`{ _tag: 'lifelabs', username, password }`)
  with fast-check arbitraries, `defaultConfig`, the captcha-aware
  login-and-analytics `scrapingPlan`, and the `LifeLabsCollectorDescriptor`.
  The response kinds come from `lifeLabsSource.responseKinds` (pre-adopted in
  the source package).
- the provenance hook — `web-trace-core`'s `makeFhirProvenanceCapture('lifelabs')`,
  one module-level line in `src/config.ts`, stated as the plan's
  `captureProvenance`. It matters here as it does for Shoppers: the resources
  are **synthesized** against a hand-reconciled schema, so the raw payload is
  the only way to check a mapping after the fact.
- the persist sink — `fhir-r4/clients`' shared `persistResources`, handed
  straight to the descriptor.
- `src/lifelabs-config-form.tsx` (+ `.module.css`) — the username/password
  `ConfigFormProps` form `collector-react` registers. The username is a plain
  text input, not `type="email"`: the login form is a username field.
- `src/index.ts` — the barrel.

Only the user-facing analytics page is ever navigated (the portal itself
redirects a signed-out visit to its IdentityServer login); the collector only
**sniffs** the XHR that page fires. **No API host (`on-api.mycarecompass.lifelabs.com`) is ever
crafted or opened directly** — those requests need auth headers the SPA
injects, and crafting them is an explicit product constraint.

## The captcha

The portal's login page carries a reCAPTCHA (the SPA's `environment.json`
ships `isRecaptchaEnabled: true` and a site key), so the plan cannot
auto-submit. The `stepSequence`:

1. `Open`s `www.on.mycarecompass.lifelabs.com/analytics`. Signed out, the SPA
   bounces to the portal's **own IdentityServer** at
   `login.on.mycarecompass.lifelabs.com`; the plan `AwaitPageSettled`s on that
   host (`continueOnTimeout: true`, so an already-signed-in session skips
   straight through), then a 2 s `Delay` so the form has rendered.
2. `Fill`s the username (an `email` input or a `Username` input — the selector
   is a list) and `input[type="password"]`. There is **no submit `Click`**.
3. **`AwaitPageRequested` on any `www.on.mycarecompass.lifelabs.com` page with
   a 5-minute timeout** — the human-in-the-loop pause. It releases once the
   user has solved the captcha, clicked Login, and the OIDC callback has
   returned to the portal host. The hold is on the page _arriving_, not
   settling, because the SPA routes to its dashboard client-side after the
   callback (the pattern `shoppers-drugmart-collector` needed for its 2FA
   pause). A stuck login aborts on timeout rather than hanging.
4. `Open`s the analytics page again as a full navigation, `AwaitPageSettled`
   on it, then a trailing `Delay` for the `GetAnalyticSummary` XHR.

No new step primitive is needed: `Fill` + `AwaitPageRequested` expresses
"autofill, then wait for the human" directly. A login-form selector that
matches nothing simply no-ops the `Fill` (the user types the field), so a
wrong guess degrades to a fully-manual login rather than failing the run.

**Not `myvisit.lifelabs.com`.** An earlier revision opened
`myvisit.lifelabs.com/login` and waited for a myVisit dashboard. myVisit is
LifeLabs' separate appointment-booking product, which MyCareCompass merely
links out to (`environment.json` carries `myVisitUrl` alongside a distinct
`identityServerUrl`); a capture of the signed-in portal shows only the
`login.on.mycarecompass.lifelabs.com` OIDC endpoints. That hold could never
release, so every run timed out after five minutes.

## What a real capture confirmed

Two anonymized web-trace captures of the signed-in portal — the **Reports**
page, then the **Analytics** page — confirmed:

- The login host and OIDC flow above (`/.well-known/openid-configuration`,
  `/connect/checksession`, `jwks`).
- The API host `on-api.mycarecompass.lifelabs.com` and its `/api/<Area>/<Op>`
  shape, with every response in the same `{ entity, caseId, isFailed, message,
statusCode, additionalData }` envelope the source's fixture assumes.
- The analytics page fires `Report/GetAnalyticSummary` (no query string), and
  the source's decode of it — see its AGENTS.md — imports the capture as one
  `Patient` plus 92 `Observation`s with no parse failures. The page also fires
  one `EnhancedLabTest/GetTestDisplayInfoExtendedIMd/<testItemId>` per analyte
  (educational topics, not results), which is ignored.
- The `Report/GetReportPatientList` rows match the `patients[]` row shape the
  source decodes (`text`, `value`, `isPrimary`, `ageCategory`,
  `isSharedPatient`, `patientMap`).
- The Reports page's own data is `Report/GetFamilyMemberReports` (one JSON row
  per report: date, lab, comma-joined test names and codes, sections, abnormal
  flag) plus `Report/ViewReports` (the rendered report as an **HTML**
  fragment, the only place per-analyte values appear on that page). Neither is
  decoded: the product decision is JSON over HTML, and the per-analyte JSON is
  the analytics page's `GetAnalyticSummary`.
- `reportList.confidentialResultsPresent` is the portal's notice that some
  results are withheld from the web view. Deliberately ignored: there is nothing
  to import, and the user already sees the notice in the portal.

## Open questions

Still unverified against a real capture:

- **Login-form selectors** — `USERNAME_SELECTOR` / `PASSWORD_SELECTOR` are
  best-guess defaults for the IdentityServer page (its DOM was not captured).
- **Already signed in** — the login settle times out and advances, but the
  sign-in hold then waits for a page that already arrived; the run ends on the
  5-minute timeout rather than the results. Same posture as Shoppers.
- **Province** — the analytics/API hosts are Ontario-specific (`on.` /
  `on-api.`; the account's `province` comes back from
  `AccountSettings/GetBasicAccountInformation`). Other provinces are a
  follow-up (parameterize the host from a `province` config field, and widen
  the source package's recognizer to match).
- The decode-side questions (units, test-code system) live with the source
  package.

## References

- [lifelabs-source AGENTS.md](../../http-extraction/lifelabs-source/AGENTS.md)
  — the response kind and resource mapping this collector consumes
- [Adding a Collector How-To](../docs/Adding%20a%20Collector%20How-To.md) — the
  recipe this collector follows
- [shoppers-drugmart-collector](../shoppers-drugmart-collector/AGENTS.md) — the
  sibling bespoke-JSON credential collector this one mirrors
- [fhir-r4](../../emr/fhir-r4) — the R4 resource types and the `upsertResource`
  write path
- [collector-fundamentals](../collector-fundamentals) — the descriptor / plan
  primitives
