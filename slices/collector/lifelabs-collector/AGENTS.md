# AGENTS.md — slices/collector/lifelabs-collector

The **LifeLabs collector**: logs into LifeLabs' `myvisit.lifelabs.com` portal
and pulls the user's lab results into the on-device FHIR **R4** store. Results
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
  text input, not `type="email"`: myVisit accepts either.
- `src/index.ts` — the barrel.

Only user-facing LifeLabs pages are ever navigated (the myVisit login page,
then the MyCareCompass analytics page); the collector only **sniffs** the XHR
that page fires. **No API host (`on-api.mycarecompass.lifelabs.com`) is ever
crafted or opened directly** — those requests need auth headers the SPA
injects, and crafting them is an explicit product constraint.

## The captcha

The myVisit login page carries a **CAPTCHA**, so the plan cannot auto-submit.
The `stepSequence`:

1. `Open`s `myvisit.lifelabs.com/login` and holds on a pattern-less
   `AwaitPageSettled` (`continueOnTimeout: true`), then a 2 s `Delay` so the
   form has rendered before the fills.
2. `Fill`s `input[type="email"]` (the username) and `input[type="password"]`.
   There is **no submit `Click`**.
3. **`AwaitPageSettled` on the `myvisit.lifelabs.com` dashboard (any path but
   `/login`) with a 5-minute timeout** — this is the human-in-the-loop pause.
   It releases only once the user has solved the captcha, clicked Login, and
   myVisit has landed on its dashboard. A stuck login aborts on timeout rather
   than hanging.
4. `Open`s `www.on.mycarecompass.lifelabs.com/analytics`, `AwaitPageSettled`
   on that page, then a trailing `Delay` for the `GetAnalyticSummary` XHR.

No new step primitive is needed: `Fill` + `AwaitPageSettled` expresses
"autofill, then wait for the human" directly. A login-form selector that
matches nothing simply no-ops the `Fill` (the user types the field), so a
wrong guess degrades to a fully-manual login rather than failing the run.

## Open questions

The fixture and selectors are synthesized/best-guess (no real capture yet).
Reconcile against a redacted `web-trace` capture before relying on the
collector end-to-end:

- **Login-form selectors** — `USERNAME_SELECTOR` / `PASSWORD_SELECTOR` are
  best-guess defaults for `myvisit.lifelabs.com/login`.
- **Login transition** — the dashboard `AwaitPageSettled` assumes the
  post-login jump surfaces a settled `PageLoaded`. If myVisit's redirect is a
  client-side SPA route, or the dashboard keeps loading past the settle
  detector, switch to `AwaitPageRequested` (the pattern
  `shoppers-drugmart-collector` needed for its 2FA pause).
- **Cross-domain session** — opening the `mycarecompass.lifelabs.com`
  analytics page after a `myvisit.lifelabs.com` login assumes a shared/SSO
  session carries over.
- **Province** — the analytics/API hosts are Ontario-specific (`on.` /
  `on-api.`). Other provinces are a follow-up (parameterize the host from a
  `province` config field, and widen the source package's recognizer to match).
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
