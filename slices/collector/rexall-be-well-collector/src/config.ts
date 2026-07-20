import {
  CollectorDescriptor,
  type EntityDefinition,
  ScrapingPlan,
  type WebViewSource,
} from 'collector-fundamentals/model'
import { Duration, type FastCheck, Schema } from 'effect'
import type { LazyArbitrary } from 'effect/Arbitrary'
import type { FhirResource } from 'fhir-r4/resources'

import { MedicationListEntity } from './entities/medication-list-entity.ts'
import { ProfileEntity } from './entities/profile-entity.ts'
import { persistResources } from './persist.ts'

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

/** The user-facing login page the sniffer webview mounts first. */
const LOGIN_URL = 'https://verify.letsbewell.ca/login'

/** The user-facing prescriptions page whose load fires the profile + list XHRs. */
const PRESCRIPTIONS_URL = 'https://app.letsbewell.ca/health/prescriptions'

/**
 * Provisional login-form selectors — an **open question** on issue #339 (the real
 * `verify.letsbewell.ca/login` DOM was not captured). These are best-guess
 * defaults for a standard email/password form; reconcile them against the real
 * page. A selector that matches nothing simply no-ops the `Fill`/`Click` (the
 * sniffer retries on the next `PageLoaded`), so a wrong guess fails the login
 * rather than the build.
 */
const EMAIL_SELECTOR = 'input[type="email"]'
const PASSWORD_SELECTOR = 'input[type="password"]'
const SUBMIT_SELECTOR = 'button[type="submit"]'

/**
 * Hold the submit `Click` until a `PageLoaded` on `app.letsbewell.ca` arrives —
 * the cross-host `verify.` → `app.` login redirect. This works only if that
 * transition is a hard document navigation (very likely for a cross-host jump),
 * not a client-side SPA route (which emits no `PageLoaded` — see the sniffer
 * caveat on #339). {@link LOGIN_TIMEOUT} bounds the wait so a stuck login aborts
 * rather than hangs.
 */
const LOGIN_ADVANCE_PATTERN = /:\/\/app\.letsbewell\.ca/
const LOGIN_TIMEOUT = Duration.seconds(30)

/**
 * Trailing settle window for the Angular XHR fan-out the prescriptions page
 * fires (the profile `/me` GET and the `pharmacy/Location?…` searchset). Keeps
 * the run open long enough for those requests to start and be tracked before the
 * queue drains, replacing the plan-wide `stepDelay` the old model had.
 */
const SETTLE = Duration.seconds(8)

/**
 * Build the Rexall scraping plan for a configured account. Every navigated page
 * is a user-facing `letsbewell.ca` page — the login page, then the prescriptions
 * page — and the collector only *sniffs* the XHRs those pages fire. **No tunnel
 * URL is ever `Open`ed directly**: the tunnel requests need auth/bearer headers
 * the Angular SPA injects, and crafting them is an explicit product constraint.
 *
 * The `stepSequence` scripts the login (Fill email, Fill password, Click submit
 * gated on the `app.letsbewell.ca` redirect), then `Open`s the prescriptions
 * page and holds open for {@link SETTLE} while its profile + list XHRs settle.
 * `ProfileEntity` recognizes `…/profile/v2/me`; `MedicationListEntity` recognizes
 * the `…/pharmacy/Location?…` searchset — disjoint patterns, so entity order is
 * not load-bearing.
 *
 * v1 is **list-only**: no per-medication detail crawl. The list `_revinclude`
 * already carries `MedicationDispense`, so the deferred `followUpSteps` crawl is
 * left out until a capture diff proves the detail XHR is richer (issue #339).
 */
const scrapingPlan = (config: InstanceConfig): ScrapingPlan.ScrapingPlan<FhirResource> => {
  const firstPage: WebViewSource.Any = { _tag: 'Uri', uri: LOGIN_URL }
  return ScrapingPlan.make<FhirResource>({
    name: 'Rexall Be Well',
    // Widening upcast (safe: `EntityDefinition` is covariant in its resource
    // type, and Patient / MedicationRequest / MedicationDispense are all
    // `FhirResource`), mirroring `fhir-r4-client-collector`.
    entityDefinitions: [
      ProfileEntity,
      MedicationListEntity,
    ] as readonly EntityDefinition.EntityDefinition<FhirResource>[],
    firstPage,
    stepSequence: [
      {
        _tag: 'Navigation',
        action: {
          _tag: 'PageAction',
          action: { kind: 'Fill', querySelector: EMAIL_SELECTOR, value: config.email },
        },
      },
      {
        _tag: 'Navigation',
        action: {
          _tag: 'PageAction',
          action: { kind: 'Fill', querySelector: PASSWORD_SELECTOR, value: config.password },
        },
      },
      {
        _tag: 'Navigation',
        action: {
          _tag: 'PageAction',
          action: { kind: 'Click', querySelector: SUBMIT_SELECTOR },
        },
        advanceWhen: { _tag: 'UrlMatch', pattern: LOGIN_ADVANCE_PATTERN, timeout: LOGIN_TIMEOUT },
      },
      {
        _tag: 'Navigation',
        action: {
          _tag: 'Open',
          source: { _tag: 'Uri', uri: PRESCRIPTIONS_URL },
        },
      },
      { _tag: 'Delay', duration: SETTLE },
    ],
  })
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
