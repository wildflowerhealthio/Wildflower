import { CollectorDescriptor, ScrapingPlan } from 'collector-fundamentals/model'
import { Duration, type FastCheck, Schema } from 'effect'
import type { LazyArbitrary } from 'effect/Arbitrary'
import { persistResources } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import { rexallBeWellSource } from 'rexall-be-well-source'

import { makeFhirProvenanceCapture } from 'web-trace-core/provenance'

const { responseKinds } = rexallBeWellSource

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

const InstanceConfig = Schema.TaggedStruct('rexall', {
  email: EmailSchema,
  password: PasswordSchema,
})

type InstanceConfig = typeof InstanceConfig.Type

/** Seeds a fresh create-form with harmless, valid placeholders the user overwrites. */
const defaultConfig: InstanceConfig = {
  _tag: 'rexall',
  email: 'you@example.com',
  password: 'your-password',
}

/** The user-facing login page the plan `Open`s first. */
const LOGIN_URL = 'https://letsbewell.ca/sign-in'

/**
 * Best-effort cap on the login page settling (`continueOnTimeout`); the
 * post-login {@link LOGIN_TIMEOUT} hold is the real gate. See AGENTS.md §
 * login-page settle.
 */
const LOGIN_PAGE_TIMEOUT = Duration.seconds(30)

/**
 * Fixed grace between the login page settling and the first `Fill`, absorbing a
 * form that renders after the page goes quiet (#339).
 */
const LOGIN_PAGE_DELAY = Duration.seconds(2)

/** The user-facing prescriptions page whose load fires the profile + list XHRs. */
const PRESCRIPTIONS_URL = 'https://app.letsbewell.ca/health/prescriptions'

/**
 * Provisional login-form selectors (#339 — the real DOM was not captured); a
 * non-matching selector no-ops the `Fill`/`Click`. Reconcile against the real
 * page.
 */
const EMAIL_SELECTOR = 'input[type="email"]'
const PASSWORD_SELECTOR = 'input[type="password"]'
const SUBMIT_SELECTOR = 'button[type="submit"]'

/**
 * The post-login redirect target (any `app.letsbewell.ca` page); the hold parks
 * on this cross-host settle before opening prescriptions. See the sniffer caveat
 * on #339.
 */
const APP_LANDED_PATTERN = /:\/\/app\.letsbewell\.ca/
const LOGIN_TIMEOUT = Duration.seconds(30)

/**
 * Pattern-less cap on the prescriptions page settling before the trailing
 * {@link SETTLE} window (the `Open` before it targets this same page).
 */
const PRESCRIPTIONS_TIMEOUT = Duration.seconds(30)

/**
 * Trailing settle window for the profile + list XHR fan-out, keeping the run
 * open until those requests are tracked.
 */
const SETTLE = Duration.seconds(8)

/**
 * Provenance hook: each response an entity derives a resource from is stored
 * verbatim as a trace `DocumentReference`. Module-level so plans from one config
 * stay deep-equal.
 */
const captureProvenance = makeFhirProvenanceCapture('rexall')<FhirResource>

/**
 * Build the Rexall scraping plan for a configured account: login → prescriptions
 * page, only sniffing the XHRs those pages fire — no tunnel URL is ever `Open`ed
 * directly. See AGENTS.md.
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
      // First `Open` — brings the sniffer up.
      {
        _tag: 'Navigation',
        name: 'Opening login page',
        action: {
          _tag: 'Open',
          source: { _tag: 'Uri', uri: LOGIN_URL },
        },
      },
      // The hold and the delay are a pair: the hold stops the delay racing the
      // page's network load, the delay absorbs a form rendered after it goes quiet.
      {
        _tag: 'AwaitPageSettled',
        name: 'Loading login page',
        timeout: LOGIN_PAGE_TIMEOUT,
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
      // Wait for the post-login redirect onto the `app.` host before opening prescriptions.
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
 * The Rexall collector as one first-class value for `collector-registry`;
 * `listSubtitle` shows the configured account email.
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
