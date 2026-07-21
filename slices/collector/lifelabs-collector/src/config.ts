import {
  CollectorDescriptor,
  type EntityDefinition,
  ScrapingPlan,
  type WebViewSource,
} from 'collector-fundamentals/model'
import { Duration, type FastCheck, Schema } from 'effect'
import type { LazyArbitrary } from 'effect/Arbitrary'
import type { FhirResource } from 'fhir-r4/resources'

import { AnalyticSummaryEntity } from './entities/analytic-summary-entity.ts'
import { persistResources } from './persist.ts'

/**
 * A LifeLabs myVisit username: any non-empty run of non-whitespace characters,
 * up to 254 chars. Deliberately looser than an email pattern — myVisit accepts
 * an email *or* a plain username, so validating for `@`/domain would reject
 * valid logins. The value is interpolated into a login `Fill` action.
 */
const usernamePattern = /^\S+$/

const arbitraryUsername: LazyArbitrary<string> = (fc: typeof FastCheck) =>
  // Non-empty, whitespace-free — the subset the schema accepts. Filtering
  // (rather than mapping to a fallback) keeps the shrinker honest, mirroring
  // the `email`/`rootUrl` arbitraries in the sibling collectors.
  fc.string({ minLength: 1, maxLength: 64 }).filter((s) => usernamePattern.test(s))

const arbitraryPassword: LazyArbitrary<string> = (fc: typeof FastCheck) =>
  fc.string({ minLength: 1, maxLength: 256 })

/**
 * The account username the user logs into LifeLabs myVisit with. Interpolated
 * into a `Fill` action's `value` — plaintext-in-config is the decided v1 secrets
 * posture (mirrors the Rexall collector), so no branding/redaction is applied.
 */
const UsernameSchema = Schema.String.pipe(
  Schema.pattern(usernamePattern, { description: 'a non-empty username with no whitespace' }),
  Schema.maxLength(254)
).annotations({ arbitrary: () => arbitraryUsername })

/**
 * The account password. Any non-empty string up to 256 chars — passwords have
 * no format to validate, only length bounds. Carried in plaintext (v1 secrets
 * posture) and interpolated into a `Fill` action's `value`.
 */
const PasswordSchema = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)).annotations({
  arbitrary: () => arbitraryPassword,
})

const InstanceConfig = Schema.TaggedStruct('lifelabs', {
  username: UsernameSchema,
  password: PasswordSchema,
})

type InstanceConfig = typeof InstanceConfig.Type

/**
 * Seeds a fresh create-form. A credential collector has no shared default
 * account — these are harmless, obviously-placeholder values the user overwrites
 * with their own credentials. Kept *valid* so the form's `defaultConfig` fallback
 * decodes.
 */
const defaultConfig: InstanceConfig = {
  _tag: 'lifelabs',
  username: 'you@example.com',
  password: 'your-password',
}

/** The user-facing myVisit login page the sniffer webview mounts first. */
const LOGIN_URL = 'https://myvisit.lifelabs.com/login'

/**
 * The user-facing MyCareCompass analytics page whose load fires the
 * `GetAnalyticSummary` XHR. Ontario-only for v1 (the `on.` / `on-api.` hosts);
 * other provinces are a noted follow-up (see AGENTS.md open questions).
 */
const ANALYTICS_URL = 'https://www.on.mycarecompass.lifelabs.com/analytics'

/**
 * Provisional login-form selectors — an **open question** (the real
 * `myvisit.lifelabs.com/login` DOM was not captured). Best-guess defaults for a
 * standard email/username + password form; reconcile them against the real page.
 *
 * There is deliberately **no submit selector / `Click`**: the login page carries
 * a **CAPTCHA**, so the plan autofills the credentials and then *waits for the
 * user* to solve the captcha and click Login themselves (see the scraping plan).
 * A selector that matches nothing simply no-ops the `Fill` (the user types the
 * field manually), so a wrong guess degrades to a fully-manual login rather than
 * failing the run.
 */
const USERNAME_SELECTOR = 'input[type="email"]'
const PASSWORD_SELECTOR = 'input[type="password"]'

/**
 * The post-login myVisit dashboard: the `myvisit.lifelabs.com` root, which is
 * **not** the `/login` page (the negative lookahead excludes it). After the two
 * credential `Fill`s, an `AwaitPageSettled` parks here until a settled
 * `PageLoaded` on this pattern arrives — i.e. until the user has solved the
 * captcha, clicked Login, and myVisit has redirected to its dashboard.
 * {@link LOGIN_TIMEOUT} bounds the manual step so a stuck login aborts rather
 * than hangs. Whether that transition is a hard navigation the sniffer reports
 * (vs. a client-side SPA route) is an open question — see AGENTS.md.
 */
const DASHBOARD_PATTERN = /:\/\/myvisit\.lifelabs\.com\/(?!login)/

/**
 * Generous bound on the manual captcha-and-login step. Unlike Rexall's 30s
 * post-submit redirect wait, this window spans a human solving a captcha, so it
 * is minutes, not seconds.
 */
const LOGIN_TIMEOUT = Duration.minutes(5)

/**
 * The MyCareCompass analytics page itself. After `Open`ing it, an
 * `AwaitPageSettled` waits for *this* page to load and settle before the trailing
 * {@link SETTLE} window — so the settle window measures quiet time on the
 * analytics page, not a race against its initial load. Matches the `www.on.`
 * host (and a bare `on.` host defensively).
 */
const ANALYTICS_SETTLED_PATTERN = /:\/\/(?:www\.)?on\.mycarecompass\.lifelabs\.com\/analytics/
const ANALYTICS_TIMEOUT = Duration.seconds(30)

/**
 * Trailing settle window for the `GetAnalyticSummary` XHR the analytics page
 * fires. Keeps the run open long enough for that request to start and be tracked
 * before the queue drains.
 */
const SETTLE = Duration.seconds(8)

/**
 * Build the LifeLabs scraping plan for a configured account. Every navigated page
 * is a user-facing LifeLabs page — the myVisit login page, then the MyCareCompass
 * analytics page — and the collector only *sniffs* the XHRs those pages fire.
 * **No API host (`on-api.mycarecompass.lifelabs.com`) is ever `Open`ed
 * directly**: those requests need auth headers the SPA injects, and crafting them
 * is an explicit product constraint (mirrors the Rexall tunnel constraint).
 *
 * The login is **captcha-gated**, so the plan does *not* click submit. It `Fill`s
 * the username and password, then holds on an `AwaitPageSettled` for the
 * post-login `myvisit.lifelabs.com` dashboard — which only settles once the user
 * has solved the captcha and clicked Login manually. It then `Open`s the
 * analytics page, waits for *it* to settle, and holds open for {@link SETTLE}
 * while its `GetAnalyticSummary` XHR settles. `AnalyticSummaryEntity` recognizes
 * that XHR and synthesizes an R4 `Patient` plus one `Observation` per analytic.
 */
const scrapingPlan = (config: InstanceConfig): ScrapingPlan.ScrapingPlan<FhirResource> => {
  const firstPage: WebViewSource.Any = { _tag: 'Uri', uri: LOGIN_URL }
  return ScrapingPlan.make<FhirResource>({
    name: 'LifeLabs',
    entityDefinitions: [
      AnalyticSummaryEntity,
    ] as readonly EntityDefinition.EntityDefinition<FhirResource>[],
    firstPage,
    stepSequence: [
      // Let the login form render before filling it.
      { _tag: 'Delay', duration: Duration.seconds(2) },
      {
        _tag: 'Navigation',
        action: {
          _tag: 'PageAction',
          action: { kind: 'Fill', querySelector: USERNAME_SELECTOR, value: config.username },
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
      // No submit `Click`: the captcha means the *user* completes the login.
      // Hold here until myVisit redirects to its dashboard (i.e. login succeeded).
      { _tag: 'AwaitPageSettled', pattern: DASHBOARD_PATTERN, timeout: LOGIN_TIMEOUT },
      {
        _tag: 'Navigation',
        action: {
          _tag: 'Open',
          source: { _tag: 'Uri', uri: ANALYTICS_URL },
        },
      },
      // Hold until the analytics page itself has loaded and settled, then give
      // its GetAnalyticSummary XHR the trailing settle window.
      {
        _tag: 'AwaitPageSettled',
        pattern: ANALYTICS_SETTLED_PATTERN,
        timeout: ANALYTICS_TIMEOUT,
      },
      { _tag: 'Delay', duration: SETTLE },
    ],
  })
}

/**
 * The LifeLabs collector as one first-class value for `collector-registry` to
 * assemble into the closed descriptor list. `title` is the collector kind
 * ("LifeLabs"); `listSubtitle` surfaces a remote's configured account username
 * (there is no server URL to show for a credential collector).
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
