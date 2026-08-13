import {
  CollectorDescriptor,
  type EntityDefinition,
  ScrapingPlan,
} from 'collector-fundamentals/model'
import { Duration, type FastCheck, Schema } from 'effect'
import type { LazyArbitrary } from 'effect/Arbitrary'
import { persistResources } from 'fhir-r4/clients'
import { adoptSourceIdentity } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import { makeFhirProvenanceCapture } from 'web-trace-core/provenance'

import { CustomerEntity } from './entities/customer-entity.ts'
import { PrescriptionEntity } from './entities/prescription-entity.ts'
import { PrescriptionHistoryEntity } from './entities/prescription-history-entity.ts'

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

/** The user-facing login page the plan opens first (redirects to `accounts.pcid.ca`). */
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
 * `Open`ing {@link LOGIN_URL} the plan holds on a *patterned* `AwaitPageSettled`
 * for this cross-host redirect before filling the credentials — filling before
 * the redirect lands would target the wrong (pre-redirect) DOM. The `pattern` is
 * load-bearing here: the awaited page (`accounts.pcid.ca`) is a *different* host
 * than the one opened (`mypharmacy…`), so a pattern-less "next settle" could
 * match the pre-redirect page.
 */
const PCID_LOGIN_PATTERN = /:\/\/accounts\.pcid\.ca\/login/
const REDIRECT_TIMEOUT = Duration.seconds(30)

/**
 * The post-login landing page: the `mypharmacy` health dashboard. After the
 * submit `Click`, the user completes 2FA on
 * `accounts.pcid.ca/login/verification`; the run **pauses** on an
 * `AwaitPageRequested` for this dashboard until that 2FA finishes and the
 * dashboard *arrives* (`DOMContentLoaded`). Arrival, not settlement, on
 * purpose: the dashboard was observed to keep loading past the sniffer's
 * settle detector, so an `AwaitPageSettled` here sat out its whole timeout
 * with the page visibly up. Its `…/api/<seg>/customers/:uuid?expand=…` XHR may
 * not have fired by the time the hold releases — acceptable, because the
 * prescription-history page fires the customers XHR again later in the run.
 * {@link TWO_FA_TIMEOUT} bounds the human-in-the-loop wait so a stalled login
 * aborts rather than hangs.
 */
const HEALTHDASHBOARD_PATTERN = /:\/\/mypharmacy\.shoppersdrugmart\.ca\/en\/healthdashboard/
const TWO_FA_TIMEOUT = Duration.minutes(5)

/**
 * Machine-side cap on waiting for the prescription dashboard to settle. After
 * `Open`ing {@link PRESCRIPTIONS_URL}, a **pattern-less** `AwaitPageSettled`
 * waits for *that* page to load and settle before the trailing {@link SETTLE}
 * window — so the settle window measures quiet time on the dashboard, not a race
 * against its initial load. Pattern-less because the `Open` immediately before
 * it targets this same page (unlike the cross-host pcid-login redirect, which
 * keeps a `pattern`).
 *
 * The hold is **best-effort** (`continueOnTimeout: true`): this is the same SPA
 * shell the plan already concludes never settles (hence the
 * {@link HEALTHDASHBOARD_PATTERN} arrival hold above it), so aborting would kill
 * the run 30 seconds after a five-minute 2FA. Pattern-less, so a late settle
 * belonging to the previous page can still release it early — a known, accepted
 * risk. Both are spelled out in the AGENTS.md § the login + 2FA flow.
 */
const PRESCRIPTIONS_TIMEOUT = Duration.seconds(30)

/**
 * Trailing settle window for the one-per-prescription `prescription-status` XHR
 * fan-out the dashboard fires. Keeps the run open long enough for those requests
 * to start and be tracked before the queue drains and the run completes.
 */
const SETTLE = Duration.seconds(8)

/**
 * The user-facing prescription-history page. Visiting it makes the SPA fire the
 * `…/api/<seg>/prescription-history?customerId=…` XHR (every dispense across all
 * prescriptions) **and** the `…/api/<seg>/customers/:id?expand=…` XHR (the
 * account + its managed people) automatically — one page visit feeds both the
 * {@link PrescriptionHistoryEntity} and {@link CustomerEntity} recognizers.
 */
const PRESCRIPTION_HISTORY_URL = 'https://mypharmacy.shoppersdrugmart.ca/en/prescription-history'

/**
 * Machine-side cap on waiting for the prescription-history page to settle. After
 * `Open`ing {@link PRESCRIPTION_HISTORY_URL}, a **pattern-less** `AwaitPageSettled`
 * waits for that page to load and settle before the trailing
 * {@link HISTORY_SETTLE} window — so the settle window measures quiet time on the
 * page, not a race against its initial load. Pattern-less because the `Open`
 * immediately before it targets this same page.
 *
 * Best-effort for the same reason as {@link PRESCRIPTIONS_TIMEOUT}, and carrying
 * the same pattern-less risk.
 */
const HISTORY_TIMEOUT = Duration.seconds(30)

/**
 * Trailing settle window for the `customers` + `prescription-history` XHRs the
 * history page fires. Keeps the run open long enough for both to start and be
 * tracked before the queue drains and the run completes.
 */
const HISTORY_SETTLE = Duration.seconds(8)

/**
 * The source system every resource this collector imports is keyed under.
 *
 * @remarks
 * A Wildflower-minted `sid` URI naming the Shoppers "mypharmacy" portal as an
 * import source, in the same style as `rexall-be-well-collector`'s
 * `REXALL_CAREBOOK_SYSTEM`. It is deliberately *not* one of `shoppers.ts`'s
 * per-field identifier systems (`SYSTEM_BASE`/`ShoppersIdentifierSystem`): those
 * name what a *field value* means (a `pcId`, a `patientId`), whereas this names
 * the *portal the whole resource came from* — the hash domain and the injected
 * `Identifier.system`. Keeping it here rather than in `shoppers.ts` mirrors that
 * split.
 *
 * **Persisted wire format.** It is the hash domain for every derived local id
 * (via {@link adoptSourceIdentity} → `localResourceId`) and the
 * `Identifier.system` written beside every source id, so changing it orphans
 * everything already imported from Shoppers Drug Mart.
 */
const SHOPPERS_DRUGMART_SYSTEM = 'https://wildflowerhealth.io/fhir/sid/shoppers-drugmart'

/**
 * This collector's provenance hook: every response an entity derives a
 * resource from is stored verbatim as a trace `DocumentReference`, linked
 * both ways to the resources it produced. Module-level — not built inside
 * the factory — so two plans built from one config share the reference and
 * stay deep-equal (`toEqual` compares functions by identity).
 */
const captureProvenance = makeFhirProvenanceCapture('shoppers-drugmart')<FhirResource>

/**
 * Build the Shoppers Drug Mart scraping plan for a configured account. Every
 * navigated page is a user-facing portal page — login → health dashboard →
 * prescription dashboard → prescription history — and the collector only
 * *sniffs* the XHRs those pages fire (the per-prescription `prescription-status`
 * GETs, and the `prescription-history` + `customers` GETs the history page
 * triggers). No API URL is ever `Open`ed directly.
 *
 * The `stepSequence` `Open`s the
 * `mypharmacy` login page — the step that brings the sniffer up — holds on a *patterned* `AwaitPageSettled` for the
 * cross-host redirect to `accounts.pcid.ca` (a different host, so the url pattern
 * disambiguates), scripts the login (Fill email, Fill password, Click submit),
 * then **pauses on an `AwaitPageRequested` for the health dashboard** while the
 * user completes 2FA on `accounts.pcid.ca/login/verification` (the dashboard only
 * loads once 2FA succeeds; arrival — not settlement — releases the hold, because
 * the dashboard never goes quiet enough to settle). It then `Open`s the
 * prescription dashboard, waits for *it* to settle with a *pattern-less*
 * `AwaitPageSettled`, holds open for {@link SETTLE} while the per-prescription
 * status XHRs settle, then `Open`s the prescription-history page and (again
 * pattern-less) holds open for {@link HISTORY_SETTLE} while its
 * `prescription-history` + `customers` XHRs settle. Every `Fill`/`Click`
 * dispatches and advances immediately (a `PageAction` fires no `PageLoaded`), so
 * the short `Delay`s between them are the only thing pacing the login form.
 * `CustomerEntity` recognizes
 * `…/customers/<uuid>`; `PrescriptionEntity` recognizes
 * `…/prescriptions/:uuid/prescription-status`; `PrescriptionHistoryEntity`
 * recognizes `…/prescription-history?customerId=…` — disjoint patterns, so entity
 * order is not load-bearing.
 *
 * The plan is wrapped in `adoptSourceIdentity` under
 * {@link SHOPPERS_DRUGMART_SYSTEM}, so every resource its entities synthesize is
 * re-keyed under a derived local id, with the portal's own id kept as
 * `identifier[0]`. No `baseUrl`: the collector only ever writes relative
 * references (`subject: Patient/<patientId>`). This is what keeps the
 * prescription `MedicationRequest`/`MedicationDispense` pair from colliding with
 * another source's ids, while `subject: Patient/<patientId>` still lands on the
 * id the adopted minimal Patient gets — both go through the one derivation.
 *
 * Provenance is the plan-level `captureProvenance` hook — the whole of this
 * collector's wiring is the one line naming it. The framework mints the run
 * id (this factory ignores its `runId` parameter — the hook receives it at
 * invocation), invokes the hook only for a response whose parse produced
 * resources, and persists the resulting trace best-effort. It matters more here
 * than for `fhir-r4-client-collector`, because this collector *synthesizes*
 * R4 resources from bespoke JSON against a hand-reconciled schema — the trace is
 * the only record of what a mapping was actually given. The factory stays
 * deterministic given its inputs, so tests deep-equal plans built from one
 * config.
 */
const scrapingPlan = (
  config: InstanceConfig,
  _runId: string
): ScrapingPlan.ScrapingPlan<FhirResource> => {
  const plan = ScrapingPlan.make<FhirResource>({
    name: 'Shoppers Drug Mart',
    // Widening upcast (safe: `EntityDefinition` is covariant in its resource
    // type, and Patient / MedicationRequest / MedicationDispense are all
    // `FhirResource`), mirroring `fhir-r4-client-collector`.
    // Order is not load-bearing — the three recognizers are disjoint by
    // construction (`/customers/<uuid>`, `/prescriptions/:uuid/prescription-status`,
    // `/prescription-history?customerId=…` — different path segments).
    entityDefinitions: [
      CustomerEntity,
      PrescriptionEntity,
      PrescriptionHistoryEntity,
    ] as readonly EntityDefinition.EntityDefinition<FhirResource>[],
    captureProvenance,
    stepSequence: [
      // Open the `mypharmacy` login page; this first `Open` builds the sniffer.
      {
        _tag: 'Navigation',
        name: 'Opening login page',
        action: {
          _tag: 'Open',
          source: { _tag: 'Uri', uri: LOGIN_URL },
        },
      },
      // Wait for the `mypharmacy` login page to redirect to the shared
      // `accounts.pcid.ca` login before filling the credentials.
      {
        _tag: 'AwaitPageSettled',
        name: 'Waiting for login page',
        pattern: PCID_LOGIN_PATTERN,
        timeout: REDIRECT_TIMEOUT,
        // An already-authenticated session skips the `accounts.pcid.ca/login`
        // redirect entirely (it lands straight on the dashboard), so this hold
        // is best-effort: on timeout, continue into the login `Fill`s rather than
        // aborting the whole run. The `Fill`/`Click` no-op against a DOM without
        // those inputs, and the later `AwaitPageRequested` still gates on the
        // dashboard.
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
      // Pause through the user's 2FA on `accounts.pcid.ca/login/verification`
      // until the health dashboard *arrives* (`DOMContentLoaded`). Arrival, not
      // settlement — the dashboard never satisfies the settle detector; see
      // `HEALTHDASHBOARD_PATTERN`.
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
      // Hold until the prescription dashboard itself has loaded and settled, then
      // give its per-prescription status XHR fan-out the trailing settle window.
      // Pattern-less: the next settle after the `Open` above is this page.
      {
        _tag: 'AwaitPageSettled',
        name: 'Waiting for prescriptions to settle',
        timeout: PRESCRIPTIONS_TIMEOUT,
        // Best-effort: this is the same SPA shell the plan already treats as
        // never-settling (hence the `AwaitPageRequested` above). Aborting would
        // discard a run right after the user's 2FA. See `PRESCRIPTIONS_TIMEOUT`.
        continueOnTimeout: true,
      },
      { _tag: 'Delay', name: 'Waiting for prescriptions', duration: SETTLE },
      // Visit the prescription-history page: its load fires both the
      // `prescription-history` and `customers` XHRs (full dispense history +
      // the account and its managed people).
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
        // Best-effort, same SPA shell — see `HISTORY_TIMEOUT`.
        continueOnTimeout: true,
      },
      { _tag: 'Delay', name: 'Done, waiting just a little longer', duration: HISTORY_SETTLE },
    ],
  })
  return adoptSourceIdentity({ system: SHOPPERS_DRUGMART_SYSTEM })(plan)
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

export {
  InstanceConfig,
  defaultConfig,
  SHOPPERS_DRUGMART_SYSTEM,
  scrapingPlan,
  ShoppersDrugMartCollectorDescriptor,
}
