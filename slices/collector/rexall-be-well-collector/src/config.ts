import {
  CollectorDescriptor,
  type EntityDefinition,
  ScrapingPlan,
  type WebViewSource,
} from 'collector-fundamentals/model'
import { Duration, type FastCheck, Schema } from 'effect'
import type { LazyArbitrary } from 'effect/Arbitrary'
import { persistResources } from 'fhir-r4/clients'
import { adoptSourceIdentity } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'

import { makeFhirProvenanceCapture } from 'web-trace-core/provenance'

import { MedicationListEntity } from './entities/medication-list-entity.ts'
import { ProfileEntity } from './entities/profile-entity.ts'

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

/**
 * The source system every resource this collector imports is keyed under.
 *
 * @remarks
 * A Wildflower-minted `sid` URI in the same style as `web-trace`'s systems, not
 * a carebook dialect constant — carebook publishes no namespace for "the id this
 * portal gave a resource", so this names the portal on its behalf. It does not
 * belong in `carebook.ts` for that reason.
 *
 * **Persisted wire format.** It is the hash domain for every derived local id
 * and the `Identifier.system` written beside every carebook id, so changing it
 * orphans everything already imported from Rexall.
 */
const REXALL_CAREBOOK_SYSTEM = 'https://wildflowerhealth.io/fhir/sid/rexall-carebook'

/** The user-facing login page the sniffer webview mounts first. */
const LOGIN_URL = 'https://letsbewell.ca/sign-in'

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
 * The prescriptions page itself (the `app.` landing above is any post-login
 * page). After `Open`ing it, an `AwaitPageSettled` hold waits for *this* page to
 * load and settle before the trailing {@link SETTLE} window — so the settle
 * window measures quiet time on the prescriptions page, not a race against its
 * initial load.
 */
const PRESCRIPTIONS_SETTLED_PATTERN = /:\/\/app\.letsbewell\.ca\/health\/prescriptions/
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
 * The `stepSequence` scripts the login (Fill email, Fill password, Click submit),
 * holds on an `AwaitPageSettled` for the post-login `app.letsbewell.ca` redirect,
 * then `Open`s the prescriptions page, waits for *it* to settle, and holds open
 * for {@link SETTLE} while its profile + list XHRs settle. Every `Fill`/`Click`
 * dispatches and advances immediately (a `PageAction` fires no `PageLoaded`), so
 * the short `Delay`s between them are the only thing pacing the login form.
 * `ProfileEntity` recognizes `…/profile/v2/me`; `MedicationListEntity` recognizes
 * the `…/pharmacy/Location?…` searchset — disjoint patterns, so entity order is
 * not load-bearing.
 *
 * v1 is **list-only**: no per-medication detail crawl. The list `_revinclude`
 * already carries `MedicationDispense`, so the deferred `followUpSteps` crawl is
 * left out until a capture diff proves the detail XHR is richer (issue #339).
 *
 * The plan is wrapped in `adoptSourceIdentity` under
 * {@link REXALL_CAREBOOK_SYSTEM}, so every resource it parses is re-keyed under
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
  const firstPage: WebViewSource.Any = { _tag: 'Uri', uri: LOGIN_URL }
  const plan = ScrapingPlan.make<FhirResource>({
    name: 'Rexall Be Well',
    entityDefinitions: [
      ProfileEntity,
      MedicationListEntity,
    ] as readonly EntityDefinition.EntityDefinition<FhirResource>[],
    captureProvenance,
    firstPage,
    stepSequence: [
      {
        _tag: 'Delay',
        name: 'Waiting for login page',
        duration: Duration.seconds(2),
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
      {
        _tag: 'AwaitPageSettled',
        name: 'Waiting for prescriptions to load',
        pattern: PRESCRIPTIONS_SETTLED_PATTERN,
        timeout: PRESCRIPTIONS_TIMEOUT,
      },
      { _tag: 'Delay', name: 'Collecting prescriptions', duration: SETTLE },
    ],
  })
  return adoptSourceIdentity({ system: REXALL_CAREBOOK_SYSTEM })(plan)
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

export {
  InstanceConfig,
  defaultConfig,
  REXALL_CAREBOOK_SYSTEM,
  scrapingPlan,
  RexallCollectorDescriptor,
}
