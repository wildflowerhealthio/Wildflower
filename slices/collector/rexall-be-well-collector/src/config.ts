import { CollectorDescriptor, ScrapingPlan } from 'collector-fundamentals/model'
import { Duration, type FastCheck, Schema } from 'effect'
import type { LazyArbitrary } from 'effect/Arbitrary'
import { persistResources } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import { rexallBeWellSource } from 'rexall-be-well-source'

import { makeFhirProvenanceCapture } from 'web-trace-core/provenance'

const { responseKinds } = rexallBeWellSource

/**
 * A well-formed email address: a non-empty local part, `@`, and a dotted
 * domain, with no whitespace. Deliberately permissive (not full RFC 5322) — it
 * rejects the obvious mistakes (missing `@`, no domain dot, embedded spaces) that
 * would make the login `Fill` meaningless, without litigating exotic-but-valid
 * addresses. The value is interpolated into a login `Fill` action.
 */
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const arbitraryEmail: LazyArbitrary<string> = (fc: typeof FastCheck) =>
  // `fc.emailAddress()` is RFC-shaped; filter to the subset this schema accepts
  // (rather than mapping to a fallback) so the shrinker stays honest, mirroring
  // the `rootUrl` arbitrary in `fhir-r4-client-collector`.
  fc.emailAddress().filter((email) => emailPattern.test(email))

const arbitraryPassword: LazyArbitrary<string> = (fc: typeof FastCheck) =>
  fc.string({ minLength: 1, maxLength: 256 })

/**
 * The account email the user logs into `letsbewell.ca` with. Interpolated into
 * a `Fill` action's `value` — plaintext-in-config is the decided v1 secrets
 * posture (per the epic), so no branding/redaction is applied here.
 */
const EmailSchema = Schema.String.pipe(
  Schema.pattern(emailPattern, { description: 'a well-formed email address' }),
  Schema.maxLength(254)
).annotations({ arbitrary: () => arbitraryEmail })

/**
 * The account password. Any non-empty string up to 256 chars — passwords have
 * no format to validate, only length bounds. Carried in plaintext (v1 secrets
 * posture) and interpolated into a `Fill` action's `value`.
 */
const PasswordSchema = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)).annotations({
  arbitrary: () => arbitraryPassword,
})

const InstanceConfig = Schema.TaggedStruct('rexall', {
  email: EmailSchema,
  password: PasswordSchema,
})

type InstanceConfig = typeof InstanceConfig.Type

/**
 * Seeds a fresh create-form. Unlike the FHIR collector (which points at a public
 * sandbox), a credential collector has no shared default account — these are
 * harmless, obviously-placeholder values the user overwrites with their own
 * credentials. Kept *valid* so the form's `defaultConfig` fallback decodes.
 */
const defaultConfig: InstanceConfig = {
  _tag: 'rexall',
  email: 'you@example.com',
  password: 'your-password',
}

/** The user-facing login page the plan `Open`s first. */
const LOGIN_URL = 'https://letsbewell.ca/sign-in'

/**
 * Machine-side cap on waiting for the login page itself to load and settle.
 * Best-effort (`continueOnTimeout: true`) — a login page that never settles is
 * still worth filling, and the post-login {@link LOGIN_TIMEOUT} hold is the real
 * gate on whether the login worked. Pattern-less is safe because there is no
 * preceding page at all — the `Open` before it is what builds the sniffer — so
 * the next settle cannot be a stale one. See the AGENTS.md § login-page settle for why the hold and
 * {@link LOGIN_PAGE_DELAY} are both needed.
 */
const LOGIN_PAGE_TIMEOUT = Duration.seconds(30)

/**
 * Fixed grace period between the login page settling and the first `Fill`. The
 * login DOM/selectors are best-guess (see #339), so this absorbs a form that
 * renders shortly after the page goes quiet.
 */
const LOGIN_PAGE_DELAY = Duration.seconds(2)

/** The user-facing prescriptions page whose load fires the profile + list XHRs. */
const PRESCRIPTIONS_URL = 'https://app.letsbewell.ca/health/prescriptions'

/**
 * Provisional login-form selectors — an **open question** on issue #339 (the real
 * `letsbewell.ca/sign-in` DOM was not captured). These are best-guess
 * defaults for a standard email/password form; reconcile them against the real
 * page. A selector that matches nothing simply no-ops the `Fill`/`Click` (the
 * sniffer retries on the next `PageLoaded`), so a wrong guess fails the login
 * rather than the build.
 */
const EMAIL_SELECTOR = 'input[type="email"]'
const PASSWORD_SELECTOR = 'input[type="password"]'
const SUBMIT_SELECTOR = 'button[type="submit"]'

/**
 * The post-login redirect target: any `app.letsbewell.ca` page. After the submit
 * `Click`, an `AwaitPageSettled` hold parks on this until a settled `PageLoaded`
 * on the `app.` host arrives — the cross-host `letsbewell.ca` → `app.` login
 * redirect. This works only if that transition surfaces a settled page load (a
 * hard document navigation, or an SPA route the sniffer's settle watch still
 * reports); {@link LOGIN_TIMEOUT} bounds the wait so a stuck login aborts rather
 * than hangs. See the sniffer caveat on #339.
 */
const APP_LANDED_PATTERN = /:\/\/app\.letsbewell\.ca/
const LOGIN_TIMEOUT = Duration.seconds(30)

/**
 * Machine-side cap on waiting for the prescriptions page to settle. After
 * `Open`ing it, a **pattern-less** `AwaitPageSettled` waits for *that* page to
 * load and settle before the trailing {@link SETTLE} window — so the settle
 * window measures quiet time on the prescriptions page, not a race against its
 * initial load. Pattern-less because the `Open` immediately before it targets
 * this same page, so the next settle is unambiguously it (unlike the post-login
 * redirect, which lands on a *different* host and so keeps a `pattern`).
 */
const PRESCRIPTIONS_TIMEOUT = Duration.seconds(30)

/**
 * Trailing settle window for the Angular XHR fan-out the prescriptions page
 * fires (the profile `/me` GET and the `pharmacy/Location?…` searchset). Keeps
 * the run open long enough for those requests to start and be tracked before the
 * queue drains, replacing the plan-wide `stepDelay` the old model had.
 */
const SETTLE = Duration.seconds(8)

/**
 * This collector's provenance hook: every response an entity derives a
 * resource from is stored verbatim as a trace `DocumentReference`, linked
 * both ways to the resources it produced. Module-level — not built inside
 * the factory — so two plans built from one config share the reference and
 * stay deep-equal (`toEqual` compares functions by identity).
 */
const captureProvenance = makeFhirProvenanceCapture('rexall')<FhirResource>

/**
 * Build the Rexall scraping plan for a configured account. Every navigated page
 * is a user-facing `letsbewell.ca` page — the login page, then the prescriptions
 * page — and the collector only *sniffs* the XHRs those pages fire. **No tunnel
 * URL is ever `Open`ed directly**: the tunnel requests need auth/bearer headers
 * the Angular SPA injects, and crafting them is an explicit product constraint.
 *
 * The `stepSequence` `Open`s the login page — the step that brings the sniffer
 * up — scripts the login (Fill email, Fill password, Click submit), holds on a
 * *patterned* `AwaitPageSettled` for the post-login `app.letsbewell.ca` redirect
 * (a different host than the login page, so the url pattern disambiguates), then
 * `Open`s the prescriptions page, waits for *it* to settle with a *pattern-less*
 * `AwaitPageSettled`, and holds open for {@link SETTLE} while its profile + list
 * XHRs settle. Every `Fill`/`Click` dispatches and advances immediately (a
 * `PageAction` fires no `PageLoaded`), so the short `Delay`s between them are the
 * only thing pacing the login form.
 * `ProfileResponseKind` recognizes `…/profile/v2/me`; `MedicationListResponseKind` recognizes
 * the `…/pharmacy/Location?…` searchset — disjoint patterns, so entity order is
 * not load-bearing.
 *
 * v1 is **list-only**: no per-medication detail crawl. The list `_revinclude`
 * already carries `MedicationDispense`, so the deferred `followUpSteps` crawl is
 * left out until a capture diff proves the detail XHR is richer (issue #339).
 *
 * `responseKinds` is the module-level {@link responseKinds}, pre-adopted under
 * `REXALL_CAREBOOK_SYSTEM`, so every resource it parses is re-keyed under
 * a derived local id with the carebook id kept as `identifier[0]`. No `baseUrl`:
 * carebook's references are relative. This is what separates a
 * `MedicationRequest` from the `MedicationDispense` that shares its carebook id
 * — the resource type is an input to the derivation — while
 * `subject: Patient/<uid>` still lands on the id the adopted profile Patient
 * gets, and `medicationReference: '#…'` fragments pass through untouched.
 *
 * Provenance is the plan-level `captureProvenance` hook — the whole of this
 * collector's wiring is the one line naming it. The framework mints the run
 * id (this factory ignores its `runId` parameter — the hook receives it at
 * invocation), invokes the hook only for a response whose parse produced
 * resources, and persists the resulting trace best-effort. It matters more
 * here than for `fhir-r4-client-collector`, because this collector
 * *translates* — the trace is the only record of what the STU3 → R4 transform
 * was actually given. The factory stays deterministic given its inputs, so
 * tests deep-equal plans built from one config.
 */
const scrapingPlan = (
  config: InstanceConfig,
  _runId: string
): ScrapingPlan.ScrapingPlan<FhirResource> => {
  const plan = ScrapingPlan.make<FhirResource>({
    name: 'Rexall Be Well',
    responseKinds,
    captureProvenance,
    stepSequence: [
      // Open the login page — the step that builds the sniffer — then wait for
      // *that page* to load and settle before pacing the form. Both steps are
      // needed: the hold stops the delay from racing the page's network load,
      // and the delay
      // still absorbs a form that renders after the page goes quiet — the login
      // DOM/selectors are best-guess, see #339.
      {
        _tag: 'Navigation',
        name: 'Opening login page',
        action: {
          _tag: 'Open',
          source: { _tag: 'Uri', uri: LOGIN_URL },
        },
      },
      {
        _tag: 'AwaitPageSettled',
        name: 'Loading login page',
        timeout: LOGIN_PAGE_TIMEOUT,
        // Best-effort: a login page that never settles is still worth filling,
        // and the post-login hold is the real gate on whether the login worked.
        continueOnTimeout: true,
      },
      {
        _tag: 'Delay',
        name: 'Waiting for login page',
        duration: LOGIN_PAGE_DELAY,
      },
      {
        _tag: 'Navigation',
        name: 'Entering email',
        action: {
          _tag: 'PageAction',
          action: { kind: 'Fill', querySelector: EMAIL_SELECTOR, value: config.email },
        },
      },
      {
        _tag: 'Delay',
        name: 'Pausing before password',
        duration: Duration.seconds(0.25),
      },
      {
        _tag: 'Navigation',
        name: 'Entering password',
        action: {
          _tag: 'PageAction',
          action: { kind: 'Fill', querySelector: PASSWORD_SELECTOR, value: config.password },
        },
      },
      {
        _tag: 'Delay',
        name: 'Pausing before submit',
        duration: Duration.seconds(0.25),
      },
      {
        _tag: 'Navigation',
        name: 'Submitting login',
        action: {
          _tag: 'PageAction',
          action: { kind: 'Click', querySelector: SUBMIT_SELECTOR },
        },
      },
      // Wait for the post-login redirect to land on the `app.` host before
      // opening the prescriptions page (opening it pre-login would bounce to the
      // sign-in screen).
      {
        _tag: 'AwaitPageSettled',
        name: 'Waiting for logged-in page',
        pattern: APP_LANDED_PATTERN,
        timeout: LOGIN_TIMEOUT,
      },
      {
        _tag: 'Navigation',
        name: 'Opening prescriptions',
        action: {
          _tag: 'Open',
          source: { _tag: 'Uri', uri: PRESCRIPTIONS_URL },
        },
      },
      // Hold until the prescriptions page itself has loaded and settled, then
      // give its profile + list XHR fan-out the trailing settle window.
      // Pattern-less: the next settle after the `Open` above is this page.
      {
        _tag: 'AwaitPageSettled',
        name: 'Waiting for prescriptions to load',
        timeout: PRESCRIPTIONS_TIMEOUT,
      },
      { _tag: 'Delay', name: 'Collecting prescriptions', duration: SETTLE },
    ],
  })
  return plan
}

/**
 * The Rexall collector as one first-class value for `collector-registry` to
 * assemble into the closed descriptor list. `title` is the collector kind
 * ("Rexall"); `listSubtitle` surfaces a remote's configured account email (there
 * is no server URL to show for a credential collector).
 */
const RexallCollectorDescriptor = CollectorDescriptor.make({
  tag: 'rexall',
  configSchema: InstanceConfig,
  defaultConfig,
  makeScrapingPlan: scrapingPlan,
  display: {
    title: 'Rexall',
    description: 'Prescriptions from Rexall Be Well (letsbewell.ca)',
    listSubtitle: (config) => config.email,
  },
  persistResources,
})

export { InstanceConfig, defaultConfig, scrapingPlan, RexallCollectorDescriptor }
