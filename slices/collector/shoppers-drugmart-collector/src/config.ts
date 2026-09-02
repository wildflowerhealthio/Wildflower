import { CollectorDescriptor, ScrapingPlan } from 'collector-fundamentals/model'
import { Duration, type FastCheck, Schema } from 'effect'
import type { LazyArbitrary } from 'effect/Arbitrary'
import { persistResources } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import { makeFhirProvenanceCapture } from 'web-trace-core/provenance'

import { shoppersDrugMartSource } from 'shoppers-drugmart-source'

const { responseKinds } = shoppersDrugMartSource

/**
 * A permissive well-formed-email check (non-empty local, `@`, dotted domain, no
 * whitespace); the value is interpolated into a login `Fill`.
 */
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const arbitraryEmail: LazyArbitrary<string> = (fc: typeof FastCheck) =>
  // Filter `fc.emailAddress()` to the subset this schema accepts so the shrinker stays honest.
  fc.emailAddress().filter((email) => emailPattern.test(email))

const arbitraryPassword: LazyArbitrary<string> = (fc: typeof FastCheck) =>
  fc.string({ minLength: 1, maxLength: 256 })

/**
 * The account login email, interpolated into a `Fill` value; plaintext per the
 * v1 secrets posture.
 */
const EmailSchema = Schema.String.pipe(
  Schema.pattern(emailPattern, { description: 'a well-formed email address' }),
  Schema.maxLength(254)
).annotations({ arbitrary: () => arbitraryEmail })

/**
 * The account password: any non-empty string up to 256 chars, carried in
 * plaintext (v1 secrets posture).
 */
const PasswordSchema = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)).annotations({
  arbitrary: () => arbitraryPassword,
})

const InstanceConfig = Schema.TaggedStruct('shoppers-drugmart', {
  email: EmailSchema,
  password: PasswordSchema,
})

type InstanceConfig = typeof InstanceConfig.Type

/** Seeds a fresh create-form with harmless, valid placeholders the user overwrites. */
const defaultConfig: InstanceConfig = {
  _tag: 'shoppers-drugmart',
  email: 'you@example.com',
  password: 'your-password',
}

/** The user-facing login page the plan opens first (redirects to `accounts.pcid.ca`). */
const LOGIN_URL = 'https://mypharmacy.shoppersdrugmart.ca/en/login'

/**
 * The prescription dashboard page whose load fans out one `prescription-status`
 * XHR per prescription.
 */
const PRESCRIPTIONS_URL =
  'https://mypharmacy.shoppersdrugmart.ca/en/prescription-dashboard/?nav=featured-services/prescription-icon'

/**
 * Login-form selectors (best-guess; a non-matching selector no-ops the
 * `Fill`/`Click`). Reconcile against the real DOM.
 */
const EMAIL_SELECTOR = 'input[type="email"]'
const PASSWORD_SELECTOR = 'input[type="password"]'
const SUBMIT_SELECTOR = 'button[type="submit"]'

/**
 * The shared PC ID login host the `mypharmacy` login page redirects to; the
 * pattern disambiguates this cross-host settle. See AGENTS.md § The login + 2FA
 * flow.
 */
const PCID_LOGIN_PATTERN = /:\/\/accounts\.pcid\.ca\/login/
const REDIRECT_TIMEOUT = Duration.seconds(30)

/**
 * The post-login dashboard the run pauses on (`AwaitPageRequested`) through the
 * user's 2FA — arrival, not settlement. See AGENTS.md § The login + 2FA flow.
 */
const HEALTHDASHBOARD_PATTERN = /:\/\/mypharmacy\.shoppersdrugmart\.ca\/en\/healthdashboard/
const TWO_FA_TIMEOUT = Duration.minutes(5)

/**
 * Best-effort cap on the prescription dashboard settling; pattern-less and
 * `continueOnTimeout`. See AGENTS.md § The login + 2FA flow.
 */
const PRESCRIPTIONS_TIMEOUT = Duration.seconds(30)

/** Trailing settle window for the per-prescription `prescription-status` XHR fan-out. */
const SETTLE = Duration.seconds(8)

/**
 * The prescription-history page; one visit fires both the `prescription-history`
 * and `customers` XHRs.
 */
const PRESCRIPTION_HISTORY_URL = 'https://mypharmacy.shoppersdrugmart.ca/en/prescription-history'

/**
 * Best-effort cap on the prescription-history page settling; pattern-less, same
 * rationale as {@link PRESCRIPTIONS_TIMEOUT}.
 */
const HISTORY_TIMEOUT = Duration.seconds(30)

/**
 * Trailing settle window for the `customers` + `prescription-history` XHRs the
 * history page fires.
 */
const HISTORY_SETTLE = Duration.seconds(8)

/**
 * Provenance hook: each response an entity synthesized from is stored verbatim as
 * a trace `DocumentReference`. Module-level so plans from one config stay
 * deep-equal.
 */
const captureProvenance = makeFhirProvenanceCapture('shoppers-drugmart')<FhirResource>

/**
 * Build the Shoppers Drug Mart scraping plan for a configured account: login →
 * 2FA pause → prescription dashboard → prescription history, only sniffing the
 * XHRs those pages fire. See AGENTS.md § The login + 2FA flow.
 */
const scrapingPlan = (
  config: InstanceConfig,
  _runId: string
): ScrapingPlan.ScrapingPlan<FhirResource> => {
  const plan = ScrapingPlan.make<FhirResource>({
    name: 'Shoppers Drug Mart',
    responseKinds,
    captureProvenance,
    stepSequence: [
      // First `Open` — brings the sniffer up.
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
        name: 'Waiting for login page',
        pattern: PCID_LOGIN_PATTERN,
        timeout: REDIRECT_TIMEOUT,
        // Best-effort: an already-authenticated session skips the pcid redirect,
        // so advance into the fills on timeout.
        continueOnTimeout: true,
      },
      { _tag: 'Delay', name: 'Waiting to enter email', duration: Duration.seconds(1) },
      {
        _tag: 'Navigation',
        name: 'Entering email',
        action: {
          _tag: 'PageAction',
          action: {
            kind: 'Fill',
            querySelector: EMAIL_SELECTOR,
            value: config.email,
          },
        },
      },
      { _tag: 'Delay', name: 'Waiting to enter password', duration: Duration.seconds(0.25) },
      {
        _tag: 'Navigation',
        name: 'Entering password',
        action: {
          _tag: 'PageAction',
          action: { kind: 'Fill', querySelector: PASSWORD_SELECTOR, value: config.password },
        },
      },
      { _tag: 'Delay', name: 'Waiting before submitting', duration: Duration.seconds(0.25) },
      {
        _tag: 'Navigation',
        name: 'Clicking submit',
        action: {
          _tag: 'PageAction',
          action: { kind: 'Click', querySelector: SUBMIT_SELECTOR },
        },
      },
      // Pause through 2FA until the dashboard arrives (`DOMContentLoaded`), not settles.
      {
        _tag: 'AwaitPageRequested',
        name: 'Waiting for Health Dashboard',
        pattern: HEALTHDASHBOARD_PATTERN,
        timeout: TWO_FA_TIMEOUT,
      },
      {
        _tag: 'Navigation',
        name: 'Opening prescriptions page',
        action: {
          _tag: 'Open',
          source: { _tag: 'Uri', uri: PRESCRIPTIONS_URL },
        },
      },
      // Pattern-less: the next settle after the `Open` above is this page.
      {
        _tag: 'AwaitPageSettled',
        name: 'Waiting for prescriptions to settle',
        timeout: PRESCRIPTIONS_TIMEOUT,
        continueOnTimeout: true,
      },
      { _tag: 'Delay', name: 'Waiting for prescriptions', duration: SETTLE },
      {
        _tag: 'Navigation',
        name: 'Opening prescription history',
        action: {
          _tag: 'Open',
          source: { _tag: 'Uri', uri: PRESCRIPTION_HISTORY_URL },
        },
      },
      // Pattern-less: the next settle after the `Open` above is this page.
      {
        _tag: 'AwaitPageSettled',
        name: 'Waiting for prescription history to settle',
        timeout: HISTORY_TIMEOUT,
        continueOnTimeout: true,
      },
      { _tag: 'Delay', name: 'Done, waiting just a little longer', duration: HISTORY_SETTLE },
    ],
  })
  return plan
}

/**
 * The Shoppers Drug Mart collector as one first-class value for
 * `collector-registry`; `listSubtitle` shows the configured account email.
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
