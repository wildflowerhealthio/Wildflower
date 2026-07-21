import {
  CollectorDescriptor,
  type EntityDefinition,
  ScrapingPlan,
  type WebViewSource,
} from 'collector-fundamentals/model'
import { Duration, type FastCheck, Schema } from 'effect'
import type { LazyArbitrary } from 'effect/Arbitrary'
import type { FhirResource } from 'fhir-r4/resources'

import { PrescriptionEntity } from './entities/prescription-entity.ts'
import { ProfileEntity } from './entities/profile-entity.ts'
import { persistResources } from './persist.ts'

/**
 * A well-formed email address: a non-empty local part, `@`, and a dotted
 * domain, with no whitespace. Deliberately permissive (not full RFC 5322) — it
 * rejects the obvious mistakes (missing `@`, no domain dot, embedded spaces)
 * that would make the login `Fill` meaningless. The value is interpolated into a
 * login `Fill` action.
 */
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const arbitraryEmail: LazyArbitrary<string> = (fc: typeof FastCheck) =>
  // `fc.emailAddress()` is RFC-shaped; filter to the subset this schema accepts
  // (rather than mapping to a fallback) so the shrinker stays honest, mirroring
  // the `rexall-be-well-collector` email arbitrary.
  fc.emailAddress().filter((email) => emailPattern.test(email))

const arbitraryPassword: LazyArbitrary<string> = (fc: typeof FastCheck) =>
  fc.string({ minLength: 1, maxLength: 256 })

/**
 * The account email the user logs into `mypharmacy.shoppersdrugmart.ca` with
 * (via the shared `accounts.pcid.ca` login). Interpolated into a `Fill` action's
 * `value` — plaintext-in-config is the v1 secrets posture (mirrors the Rexall
 * collector), so no branding/redaction is applied here.
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

const InstanceConfig = Schema.TaggedStruct('shoppers-drugmart', {
  email: EmailSchema,
  password: PasswordSchema,
})

type InstanceConfig = typeof InstanceConfig.Type

/**
 * Seeds a fresh create-form. A credential collector has no shared default
 * account — these are harmless, obviously-placeholder values the user overwrites
 * with their own credentials. Kept *valid* so the form's `defaultConfig`
 * fallback decodes.
 */
const defaultConfig: InstanceConfig = {
  _tag: 'shoppers-drugmart',
  email: 'you@example.com',
  password: 'your-password',
}

/** The user-facing login page the sniffer webview mounts first (redirects to `accounts.pcid.ca`). */
const LOGIN_URL = 'https://mypharmacy.shoppersdrugmart.ca/en/login'

/**
 * The prescription dashboard page whose load fans out one
 * `…/prescriptions/:uuid/prescription-status` XHR per prescription.
 */
const PRESCRIPTIONS_URL =
  'https://mypharmacy.shoppersdrugmart.ca/en/prescription-dashboard/?nav=featured-services/prescription-icon'

/**
 * Login-form selectors. The task specifies filling `type="email"` and
 * `type="password"` on the shared `accounts.pcid.ca/login` page; the submit
 * selector is a best-guess standard submit button. A selector that matches
 * nothing simply no-ops the `Fill`/`Click`, so a wrong guess fails the login
 * rather than the build (reconcile against the real DOM).
 */
const EMAIL_SELECTOR = 'input[type="email"]'
const PASSWORD_SELECTOR = 'input[type="password"]'
const SUBMIT_SELECTOR = 'button[type="submit"]'

/**
 * The shared PC ID login host the `mypharmacy` login page redirects to. After
 * mounting {@link LOGIN_URL} the plan holds on an `AwaitPageSettled` for this
 * cross-host redirect before filling the credentials — filling before the
 * redirect lands would target the wrong (pre-redirect) DOM.
 */
const PCID_LOGIN_PATTERN = /:\/\/accounts\.pcid\.ca\/login/
const REDIRECT_TIMEOUT = Duration.seconds(30)

/**
 * The post-login landing page: the `mypharmacy` health dashboard. After the
 * submit `Click`, the user completes 2FA on
 * `accounts.pcid.ca/login/verification`; the run **pauses** on an
 * `AwaitPageSettled` for this dashboard until that 2FA finishes and the
 * dashboard loads and settles (its `…/api/profile/getProfile/` XHR fires and is
 * sniffed while it settles). {@link TWO_FA_TIMEOUT} bounds the human-in-the-loop
 * wait so a stalled login aborts rather than hangs.
 */
const HEALTHDASHBOARD_PATTERN = /:\/\/mypharmacy\.shoppersdrugmart\.ca\/en\/healthdashboard/
const TWO_FA_TIMEOUT = Duration.minutes(5)

/**
 * The prescription dashboard itself. After `Open`ing {@link PRESCRIPTIONS_URL},
 * an `AwaitPageSettled` hold waits for *this* page to load and settle before the
 * trailing {@link SETTLE} window — so the settle window measures quiet time on
 * the dashboard, not a race against its initial load.
 */
const PRESCRIPTIONS_SETTLED_PATTERN =
  /:\/\/mypharmacy\.shoppersdrugmart\.ca\/en\/prescription-dashboard/
const PRESCRIPTIONS_TIMEOUT = Duration.seconds(30)

/**
 * Trailing settle window for the one-per-prescription `prescription-status` XHR
 * fan-out the dashboard fires. Keeps the run open long enough for those requests
 * to start and be tracked before the queue drains and the run completes.
 */
const SETTLE = Duration.seconds(8)

/**
 * Build the Shoppers Drug Mart scraping plan for a configured account. Every
 * navigated page is a user-facing portal page — the login page, then the
 * prescription dashboard — and the collector only *sniffs* the XHRs those pages
 * fire (the profile `getProfile` GET and the per-prescription `prescription-status`
 * GETs). No API URL is ever `Open`ed directly.
 *
 * The `stepSequence` waits for the cross-host redirect to `accounts.pcid.ca`,
 * scripts the login (Fill email, Fill password, Click submit), then **pauses on
 * an `AwaitPageSettled` for the health dashboard** while the user completes 2FA
 * on `accounts.pcid.ca/login/verification` (the dashboard only loads once 2FA
 * succeeds; its `getProfile` XHR is sniffed as it settles). It then `Open`s the
 * prescription dashboard, waits for *it* to settle, and holds open for
 * {@link SETTLE} while the per-prescription status XHRs settle. Every
 * `Fill`/`Click` dispatches and advances immediately (a `PageAction` fires no
 * `PageLoaded`), so the short `Delay`s between them are the only thing pacing the
 * login form. `ProfileEntity` recognizes `…/profile/getProfile/`;
 * `PrescriptionEntity` recognizes `…/prescriptions/:uuid/prescription-status` —
 * disjoint patterns, so entity order is not load-bearing.
 */
const scrapingPlan = (config: InstanceConfig): ScrapingPlan.ScrapingPlan<FhirResource> => {
  const firstPage: WebViewSource.Any = { _tag: 'Uri', uri: LOGIN_URL }
  return ScrapingPlan.make<FhirResource>({
    name: 'Shoppers Drug Mart',
    // Widening upcast (safe: `EntityDefinition` is covariant in its resource
    // type, and Patient / MedicationRequest / MedicationDispense are all
    // `FhirResource`), mirroring `fhir-r4-client-collector`.
    entityDefinitions: [
      ProfileEntity,
      PrescriptionEntity,
    ] as readonly EntityDefinition.EntityDefinition<FhirResource>[],
    firstPage,
    stepSequence: [
      // Wait for the `mypharmacy` login page to redirect to the shared
      // `accounts.pcid.ca` login before filling the credentials.
      { _tag: 'AwaitPageSettled', pattern: PCID_LOGIN_PATTERN, timeout: REDIRECT_TIMEOUT },
      {
        _tag: 'Navigation',
        action: {
          _tag: 'PageAction',
          action: { kind: 'Fill', querySelector: EMAIL_SELECTOR, value: config.email },
        },
      },
      { _tag: 'Delay', duration: Duration.seconds(0.25) },
      {
        _tag: 'Navigation',
        action: {
          _tag: 'PageAction',
          action: { kind: 'Fill', querySelector: PASSWORD_SELECTOR, value: config.password },
        },
      },
      { _tag: 'Delay', duration: Duration.seconds(0.25) },
      {
        _tag: 'Navigation',
        action: {
          _tag: 'PageAction',
          action: { kind: 'Click', querySelector: SUBMIT_SELECTOR },
        },
      },
      // Pause through the user's 2FA on `accounts.pcid.ca/login/verification`
      // until the health dashboard loads and settles (its `getProfile` XHR is
      // sniffed as it settles).
      { _tag: 'AwaitPageSettled', pattern: HEALTHDASHBOARD_PATTERN, timeout: TWO_FA_TIMEOUT },
      {
        _tag: 'Navigation',
        action: {
          _tag: 'Open',
          source: { _tag: 'Uri', uri: PRESCRIPTIONS_URL },
        },
      },
      // Hold until the prescription dashboard itself has loaded and settled, then
      // give its per-prescription status XHR fan-out the trailing settle window.
      {
        _tag: 'AwaitPageSettled',
        pattern: PRESCRIPTIONS_SETTLED_PATTERN,
        timeout: PRESCRIPTIONS_TIMEOUT,
      },
      { _tag: 'Delay', duration: SETTLE },
    ],
  })
}

/**
 * The Shoppers Drug Mart collector as one first-class value for
 * `collector-registry` to assemble into the closed descriptor list. `title` is
 * the collector kind ("Shoppers Drug Mart"); `listSubtitle` surfaces a remote's
 * configured account email (there is no server URL to show for a credential
 * collector).
 */
const ShoppersDrugMartCollectorDescriptor = CollectorDescriptor.make({
  tag: 'shoppers-drugmart',
  configSchema: InstanceConfig,
  defaultConfig,
  makeScrapingPlan: scrapingPlan,
  display: {
    title: 'Shoppers Drug Mart',
    description: 'Prescriptions from Shoppers Drug Mart (mypharmacy.shoppersdrugmart.ca)',
    listSubtitle: (config) => config.email,
  },
  persistResources,
})

export { InstanceConfig, defaultConfig, scrapingPlan, ShoppersDrugMartCollectorDescriptor }
