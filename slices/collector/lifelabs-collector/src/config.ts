import { CollectorDescriptor, ScrapingPlan } from 'collector-fundamentals/model'
import { Duration, type FastCheck, Schema } from 'effect'
import type { LazyArbitrary } from 'effect/Arbitrary'
import { persistResources } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import { makeFhirProvenanceCapture } from 'web-trace-core/provenance'

import { lifeLabsSource } from 'lifelabs-source'

const { responseKinds } = lifeLabsSource

/**
 * A myVisit username: any non-empty run of non-whitespace characters. Looser
 * than an email pattern on purpose — myVisit accepts an email *or* a plain
 * username, so validating for `@`/domain would reject valid logins. The value
 * is interpolated into a login `Fill`.
 */
const usernamePattern = /^\S+$/

const arbitraryUsername: LazyArbitrary<string> = (fc: typeof FastCheck) =>
  // Filter to the schema's subset so the shrinker stays honest.
  fc.string({ minLength: 1, maxLength: 64 }).filter((s) => usernamePattern.test(s))

const arbitraryPassword: LazyArbitrary<string> = (fc: typeof FastCheck) =>
  fc.string({ minLength: 1, maxLength: 256 })

/** The account username, interpolated into a `Fill` value; plaintext per the v1 secrets posture. */
const UsernameSchema = Schema.String.pipe(
  Schema.pattern(usernamePattern, { description: 'a non-empty username with no whitespace' }),
  Schema.maxLength(254)
).annotations({ arbitrary: () => arbitraryUsername })

/**
 * The account password: any non-empty string up to 256 chars, carried in
 * plaintext (v1 secrets posture).
 */
const PasswordSchema = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)).annotations({
  arbitrary: () => arbitraryPassword,
})

const InstanceConfig = Schema.TaggedStruct('lifelabs', {
  username: UsernameSchema,
  password: PasswordSchema,
})

type InstanceConfig = typeof InstanceConfig.Type

/** Seeds a fresh create-form with harmless, valid placeholders the user overwrites. */
const defaultConfig: InstanceConfig = {
  _tag: 'lifelabs',
  username: 'you@example.com',
  password: 'your-password',
}

/** The user-facing myVisit login page the plan opens first. */
const LOGIN_URL = 'https://myvisit.lifelabs.com/login'

/**
 * The user-facing MyCareCompass analytics page whose load fires the
 * `GetAnalyticSummary` XHR. Ontario-only for v1 (the `on.` / `on-api.` hosts).
 */
const ANALYTICS_URL = 'https://www.on.mycarecompass.lifelabs.com/analytics'

/**
 * Login-form selectors (best-guess; a non-matching selector no-ops the `Fill`
 * and the user types the field). Reconcile against the real DOM. There is
 * deliberately no submit selector — see AGENTS.md § The captcha.
 */
const USERNAME_SELECTOR = 'input[type="email"]'
const PASSWORD_SELECTOR = 'input[type="password"]'

/** Best-effort cap on the login page settling before the credential fills. */
const LOGIN_PAGE_TIMEOUT = Duration.seconds(30)

/**
 * The post-login myVisit dashboard: the `myvisit.lifelabs.com` host on any path
 * but `/login`. The run parks here through the user's captcha-and-login step.
 * See AGENTS.md § The captcha.
 */
const DASHBOARD_PATTERN = /:\/\/myvisit\.lifelabs\.com\/(?!login)/
const LOGIN_TIMEOUT = Duration.minutes(5)

/** The analytics page itself (`www.on.` host, or a bare `on.` host defensively). */
const ANALYTICS_SETTLED_PATTERN = /:\/\/(?:www\.)?on\.mycarecompass\.lifelabs\.com\/analytics/
const ANALYTICS_TIMEOUT = Duration.seconds(30)

/** Trailing settle window for the `GetAnalyticSummary` XHR the analytics page fires. */
const SETTLE = Duration.seconds(8)

/**
 * Provenance hook: each response the kind synthesized from is stored verbatim
 * as a trace `DocumentReference`. Module-level so plans from one config stay
 * deep-equal.
 */
const captureProvenance = makeFhirProvenanceCapture('lifelabs')<FhirResource>

/**
 * Build the LifeLabs scraping plan for a configured account: open the myVisit
 * login → autofill the credentials → hold for the user to solve the captcha
 * and log in → open the MyCareCompass analytics page and settle, only sniffing
 * the XHR that page fires. See AGENTS.md § The captcha.
 */
const scrapingPlan = (
  config: InstanceConfig,
  _runId: string
): ScrapingPlan.ScrapingPlan<FhirResource> =>
  ScrapingPlan.make<FhirResource>({
    name: 'LifeLabs',
    responseKinds,
    captureProvenance,
    stepSequence: [
      // First `Open` — brings the sniffer up.
      {
        _tag: 'Navigation',
        name: 'Opening login page',
        action: { _tag: 'Open', source: { _tag: 'Uri', uri: LOGIN_URL } },
      },
      // Pattern-less: the next settle after the `Open` above is the login page.
      {
        _tag: 'AwaitPageSettled',
        name: 'Waiting for login page',
        timeout: LOGIN_PAGE_TIMEOUT,
        // Best-effort: a settle an SPA reaches before the form renders is still
        // followed by the `Delay` below, so advance rather than abort.
        continueOnTimeout: true,
      },
      { _tag: 'Delay', name: 'Waiting to enter username', duration: Duration.seconds(2) },
      {
        _tag: 'Navigation',
        name: 'Entering username',
        action: {
          _tag: 'PageAction',
          action: { kind: 'Fill', querySelector: USERNAME_SELECTOR, value: config.username },
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
      // No submit `Click`: the captcha means the *user* completes the login.
      // Hold until myVisit lands on its dashboard (i.e. login succeeded).
      {
        _tag: 'AwaitPageSettled',
        name: 'Waiting for you to solve the captcha and log in',
        pattern: DASHBOARD_PATTERN,
        timeout: LOGIN_TIMEOUT,
      },
      {
        _tag: 'Navigation',
        name: 'Opening lab results',
        action: { _tag: 'Open', source: { _tag: 'Uri', uri: ANALYTICS_URL } },
      },
      // Hold until the analytics page itself has settled, then give its
      // GetAnalyticSummary XHR the trailing settle window.
      {
        _tag: 'AwaitPageSettled',
        name: 'Waiting for lab results to settle',
        pattern: ANALYTICS_SETTLED_PATTERN,
        timeout: ANALYTICS_TIMEOUT,
      },
      { _tag: 'Delay', name: 'Done, waiting just a little longer', duration: SETTLE },
    ],
  })

/**
 * The LifeLabs collector as one first-class value for `collector-registry`;
 * `listSubtitle` shows the configured account username.
 */
const LifeLabsCollectorDescriptor = CollectorDescriptor.make({
  tag: 'lifelabs',
  configSchema: InstanceConfig,
  defaultConfig,
  makeScrapingPlan: scrapingPlan,
  display: {
    title: 'LifeLabs',
    description: 'Lab results from LifeLabs MyCareCompass (myvisit.lifelabs.com)',
    listSubtitle: (config) => config.username,
  },
  persistResources,
})

export { InstanceConfig, defaultConfig, scrapingPlan, LifeLabsCollectorDescriptor }
