import { CollectorDescriptor, ScrapingPlan } from 'collector-fundamentals/model'
import { Duration, type FastCheck, Schema } from 'effect'
import type { LazyArbitrary } from 'effect/Arbitrary'
import { persistResources } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import { makeFhirProvenanceCapture } from 'web-trace-core/provenance'

import { lifeLabsSource } from 'lifelabs-source'

const { responseKinds } = lifeLabsSource

/**
 * A MyCareCompass username: any non-empty run of non-whitespace characters.
 * Looser than an email pattern on purpose — the account carries an `email`,
 * but the login form is a plain username field, so validating for `@`/domain
 * would reject a login that works. The value is interpolated into a login
 * `Fill`.
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

/**
 * The user-facing MyCareCompass analytics page whose load fires the
 * `GetAnalyticSummary` XHR, and the plan's first `Open`: signed out, the SPA
 * bounces it to the portal's own IdentityServer login (below). Ontario-only for
 * v1 (the `on.` / `on-api.` hosts).
 */
const ANALYTICS_URL = 'https://www.on.mycarecompass.lifelabs.com/analytics'

/**
 * The portal's IdentityServer login host, where the analytics `Open` lands
 * when signed out. This is **not** `myvisit.lifelabs.com` — myVisit is
 * LifeLabs' separate appointment-booking product, linked out to from the
 * portal; a capture of the signed-in portal shows only this host's OIDC
 * endpoints. See AGENTS.md § The captcha.
 */
const LOGIN_PATTERN = /:\/\/login\.on\.mycarecompass\.lifelabs\.com\//
const LOGIN_TIMEOUT = Duration.seconds(30)

/**
 * Login-form selectors on the IdentityServer page (best-guess; a non-matching
 * selector no-ops the `Fill` and the user types the field). The username
 * selector is a list so it survives the field being an `email` input or a
 * plain `Username` input. There is deliberately no submit selector — see
 * AGENTS.md § The captcha.
 */
const USERNAME_SELECTOR = 'input[type="email"], input[name="Username"], input[name="username"]'
const PASSWORD_SELECTOR = 'input[type="password"]'

/**
 * Where the login returns to: any page on the signed-in portal host. The OIDC
 * callback arrives here first and the SPA then routes client-side, so the hold
 * is on the page *arriving* (`AwaitPageRequested`), not settling. The run
 * parks here through the user's captcha-and-login step. See AGENTS.md § The
 * captcha.
 */
const SIGNED_IN_PATTERN = /:\/\/www\.on\.mycarecompass\.lifelabs\.com\//
const SIGN_IN_TIMEOUT = Duration.minutes(5)

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
 * Build the LifeLabs scraping plan for a configured account: open the
 * analytics page → get bounced to the portal's IdentityServer login → autofill
 * the credentials → hold for the user to solve the captcha and log in → once
 * back on the portal, open the analytics page again and settle, only sniffing
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
      // First `Open` — brings the sniffer up. Signed out, the SPA redirects to
      // the IdentityServer login; signed in, this is already the results page.
      {
        _tag: 'Navigation',
        name: 'Opening lab results',
        action: { _tag: 'Open', source: { _tag: 'Uri', uri: ANALYTICS_URL } },
      },
      {
        _tag: 'AwaitPageSettled',
        name: 'Waiting for login page',
        pattern: LOGIN_PATTERN,
        timeout: LOGIN_TIMEOUT,
        // Best-effort: an already-authenticated session never reaches the
        // login host, so advance into the (no-op) fills on timeout.
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
      // Hold until the login returns to the portal host (i.e. login succeeded).
      {
        _tag: 'AwaitPageRequested',
        name: 'Waiting for you to solve the captcha and log in',
        pattern: SIGNED_IN_PATTERN,
        timeout: SIGN_IN_TIMEOUT,
      },
      // The callback lands on the dashboard, so open the results page again as
      // a full navigation and give its GetAnalyticSummary XHR the trailing
      // settle window.
      {
        _tag: 'Navigation',
        name: 'Reopening lab results',
        action: { _tag: 'Open', source: { _tag: 'Uri', uri: ANALYTICS_URL } },
      },
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
    description: 'Lab results from LifeLabs MyCareCompass (mycarecompass.lifelabs.com)',
    listSubtitle: (config) => config.username,
  },
  persistResources,
})

export { InstanceConfig, defaultConfig, scrapingPlan, LifeLabsCollectorDescriptor }
