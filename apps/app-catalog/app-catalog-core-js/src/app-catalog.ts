/**
 * The schema of Wildflower's App Catalog, a [HALO 2.0.0-DFT-preBallot App
 * Catalog](https://simplifier.net/guide/halo/Home/HALO-Components/App-Catalog):
 * a JSON array of application objects, served at {@link CATALOG_URL}. The file
 * is static and hand-edited; `app-catalog-web` publishes it and a test there
 * decodes it with {@link Catalog}.
 *
 * Namespace module (`import { AppCatalog } from '@wildflowerhealthio/app-catalog-core-js'`):
 * the document is `AppCatalog.Catalog`, one application `AppCatalog.App`, with
 * `AppCatalog.TAG_LABELS`, `AppCatalog.CATALOG_URL`, …
 */

import { sectionUrl } from '@wildflowerhealthio/branding-core'
import { Scope } from '@wildflowerhealthio/scopes-core'
import { Schema } from 'effect'

import { CATALOG_PATH } from './location.ts'

/** The longest URL HALO allows in any URL field. */
const MAX_URL_LENGTH = 2048

/** The longest `eligibilityCriteria` HALO allows. */
const MAX_ELIGIBILITY_CRITERIA_LENGTH = 2048

/**
 * A URL a published catalog links to: an absolute `https:` URL of at most
 * {@link MAX_URL_LENGTH} characters, carrying no credentials, written exactly
 * as the WHATWG URL parser writes it back. The parser forgives a padded
 * `" https://x/"`, a slashless `https:example.com` or a backslashed
 * `https:\\example.com`, which a stricter client might not; a bare origin
 * takes its trailing `/`.
 */
const HttpsUrl = Schema.String.pipe(
  Schema.maxLength(MAX_URL_LENGTH),
  Schema.filter((text) => {
    if (!URL.canParse(text)) return `${JSON.stringify(text)} is not a URL`
    const url = new URL(text)
    if (url.protocol !== 'https:') return `${JSON.stringify(text)} is not an https: URL`
    if (url.username !== '' || url.password !== '') {
      return `${JSON.stringify(text)} carries credentials, which a published file must not`
    }
    if (url.href !== text) {
      return `${JSON.stringify(text)} is not written canonically: write ${JSON.stringify(url.href)}`
    }
    return true
  }),
  Schema.annotations({ identifier: 'HttpsUrl' })
)
type HttpsUrl = typeof HttpsUrl.Type

/**
 * The URL that starts an app's SMART launch: an {@link HttpsUrl} with no `iss`
 * or `launch` query parameter, since the launcher adds them for the server it
 * launches against.
 */
const LaunchUrl = HttpsUrl.pipe(
  Schema.filter((text) => {
    const { searchParams } = new URL(text)
    if (searchParams.has('iss') || searchParams.has('launch')) {
      return `${JSON.stringify(text)} carries iss or launch, which the launcher adds`
    }
    return true
  }),
  Schema.annotations({ identifier: 'LaunchUrl' })
)
type LaunchUrl = typeof LaunchUrl.Type

/**
 * A URL the authorization server returns to: an {@link HttpsUrl} with no
 * fragment (RFC 6749 §3.1.2).
 */
const RedirectUri = HttpsUrl.pipe(
  Schema.filter(
    (text) =>
      !text.includes('#') ||
      `${JSON.stringify(text)} carries a fragment, which a redirect URI must not`
  ),
  Schema.annotations({ identifier: 'RedirectUri' })
)
type RedirectUri = typeof RedirectUri.Type

/**
 * One scope an app sends to `/authorize`: a string `scopes-core`'s
 * `Scope.parse` reads as a FHIR, Wildflower or known scope, not as `unknown`.
 */
const SmartScope = Schema.String.pipe(
  Schema.filter(
    (scope) =>
      Scope.parse(scope).kind !== 'unknown' || `${JSON.stringify(scope)} is not a SMART scope`
  ),
  Schema.annotations({ identifier: 'SmartScope' })
)
type SmartScope = typeof SmartScope.Type

/**
 * What an app is for, from a closed list: a new tag is a change to this
 * schema, and a catalog naming any other fails to decode. Displayed as its
 * {@link TAG_LABELS} entry.
 */
const Tag = Schema.Literal(
  'medications',
  'lab-results',
  'vitals',
  'charts',
  'fitness',
  'imaging',
  'pediatrics',
  'cardiology',
  'risk-calculator',
  'data-import',
  'test-data',
  'developer'
).annotations({ identifier: 'Tag' })
type Tag = typeof Tag.Type

/** The display label of each {@link Tag}. */
const TAG_LABELS: Readonly<Record<Tag, string>> = {
  medications: 'Medications',
  'lab-results': 'Lab results',
  vitals: 'Vitals',
  charts: 'Charts over time',
  fitness: 'Fitness',
  imaging: 'Imaging',
  pediatrics: "Children's health",
  cardiology: 'Heart health',
  'risk-calculator': 'Risk calculators',
  'data-import': 'Data import',
  'test-data': 'Test data',
  developer: 'For developers',
}

/** A BCP 47 language tag: `en`, `en-CA`. */
const LanguageTag = Schema.String.pipe(
  Schema.filter((text) => {
    try {
      Intl.getCanonicalLocales(text)
      return true
    } catch {
      return `${JSON.stringify(text)} is not a BCP 47 language tag`
    }
  }),
  Schema.annotations({ identifier: 'LanguageTag' })
)
type LanguageTag = typeof LanguageTag.Type

/** One way to reach an app's support: a titled email, phone number or URL. */
const Contact = Schema.Struct({
  /** Who or what the contact is: `Ruth Marks`, `Issues and questions`. */
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(150)),
  email: Schema.optional(
    Schema.String.pipe(Schema.maxLength(150), Schema.pattern(/^[^\s@]+@[^\s@]+$/))
  ),
  phone: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(30))),
  url: Schema.optional(HttpsUrl),
}).annotations({ identifier: 'Contact' })
type Contact = typeof Contact.Type

/**
 * An app's contacts: at least one with an email and at least one with a URL,
 * which may be the same contact.
 */
const Contacts = Schema.Array(Contact).pipe(
  Schema.filter((contacts) => {
    if (!contacts.some(({ email }) => email !== undefined)) return 'no contact has an email'
    if (!contacts.some(({ url }) => url !== undefined)) return 'no contact has a URL'
    return true
  }),
  Schema.annotations({ identifier: 'Contacts' })
)

/** Who publishes an app, identified across the catalog by a UUID. */
const Publisher = Schema.Struct({
  id: Schema.UUID,
  name: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(150)),
  /** The publisher's website. */
  url: Schema.optional(HttpsUrl),
}).annotations({ identifier: 'Publisher' })
type Publisher = typeof Publisher.Type

/**
 * How a server may register an app as an OAuth client: `dcr`, by dynamic
 * client registration; `preassigned`, by copying the registration the catalog
 * carries ({@link PreassignedCredentials}). An app naming neither has its
 * registration negotiated out of band.
 */
const RegistrationMode = Schema.Literal('dcr', 'preassigned').annotations({
  identifier: 'RegistrationMode',
})
type RegistrationMode = typeof RegistrationMode.Type

/** An app's registration modes, none named twice. */
const RegistrationModes = Schema.Array(RegistrationMode).pipe(
  Schema.filter(
    (modes) => new Set(modes).size === modes.length || 'registrationModes names a mode twice'
  ),
  Schema.annotations({ identifier: 'RegistrationModes' })
)

/** A grant an app uses at `/token`. */
const GrantType = Schema.Literal(
  'authorization_code',
  'refresh_token',
  'client_credentials'
).annotations({ identifier: 'GrantType' })
type GrantType = typeof GrantType.Type

/**
 * How an app authenticates at `/token`: `none` for a browser app, which keeps
 * no secret and proves itself with PKCE instead.
 */
const TokenEndpointAuthMethod = Schema.Literal(
  'client_secret_post',
  'client_secret_basic',
  'private_key_jwt',
  'none'
).annotations({ identifier: 'TokenEndpointAuthMethod' })
type TokenEndpointAuthMethod = typeof TokenEndpointAuthMethod.Type

/**
 * An app's OAuth client registration, what a server needs to register the app
 * as a client: RFC 7591's client metadata in camelCase.
 */
const PreassignedCredentials = Schema.Struct({
  /** The `client_id` the app sends to `/authorize` and `/token`. */
  clientId: Schema.NonEmptyTrimmedString,
  grantTypes: Schema.NonEmptyArray(GrantType),
  tokenEndpointAuthMethod: TokenEndpointAuthMethod,
  /** Where the app publishes the keys it signs its `private_key_jwt` assertions with. */
  jwksUri: Schema.optional(HttpsUrl),
  /** The redirect URIs the app returns to. */
  redirectUris: Schema.optional(Schema.NonEmptyArray(RedirectUri)),
  /** Where the app may ask to land after signing out. */
  postLogoutRedirectUris: Schema.optional(Schema.NonEmptyArray(RedirectUri)),
}).pipe(
  Schema.filter(
    ({ grantTypes, tokenEndpointAuthMethod, jwksUri, redirectUris, postLogoutRedirectUris }) => {
      const authorizationCode = grantTypes.includes('authorization_code')
      if (grantTypes.includes('refresh_token') && !authorizationCode) {
        return 'refresh_token SHALL be paired with authorization_code'
      }
      if (tokenEndpointAuthMethod === 'private_key_jwt' && jwksUri === undefined) {
        return 'jwksUri SHALL be present when tokenEndpointAuthMethod is private_key_jwt'
      }
      if (authorizationCode && redirectUris === undefined) {
        return 'redirectUris SHALL be present when grantTypes includes authorization_code'
      }
      if (postLogoutRedirectUris !== undefined && !authorizationCode) {
        return 'postLogoutRedirectUris applies only when grantTypes includes authorization_code'
      }
      return true
    }
  ),
  Schema.annotations({ identifier: 'PreassignedCredentials' })
)
type PreassignedCredentials = typeof PreassignedCredentials.Type

/** A launch intent an app accepts: its `name` is passed as the launch's intent. */
const Intent = Schema.Struct({
  name: Schema.NonEmptyTrimmedString,
  /** What the app does when launched with this intent. */
  description: Schema.NonEmptyTrimmedString,
}).annotations({ identifier: 'Intent' })
type Intent = typeof Intent.Type

/** An app's launch intents, no two sharing a name. */
const Intents = Schema.Array(Intent).pipe(
  Schema.filter((intents) => {
    const names = intents.map(({ name }) => name)
    return new Set(names).size === names.length || 'two intents share a name'
  }),
  Schema.annotations({ identifier: 'Intents' })
)

/**
 * The fields every application object carries, whatever its `type`, with the
 * type-dependent ones (`launchUrl`, `onboardingEndpoint`, `offboardingEndpoint`)
 * read as optional so a misplaced one fails a named rule instead of being
 * dropped.
 */
const applicationFields = {
  /** The app's RFC 4122 UUID, unique within the catalog and stable across edits. */
  id: Schema.UUID,
  /** The app's display name. */
  name: Schema.NonEmptyTrimmedString.pipe(Schema.minLength(3), Schema.maxLength(150)),
  /** What the app does, for the person deciding whether to use it. */
  description: Schema.NonEmptyTrimmedString,
  /** One sentence saying what the app does, for where space is short. */
  descriptionShort: Schema.NonEmptyTrimmedString,
  /** The language this entry's metadata is written in. */
  contentLanguage: LanguageTag,
  /** The languages the app itself works in once launched. */
  languagesSupported: Schema.optional(Schema.Array(LanguageTag)),
  tags: Schema.optional(Schema.Array(Tag)),
  /** The app's help or support page. */
  helpUrl: Schema.optional(HttpsUrl),
  iconUrl: HttpsUrl,
  screenshots: Schema.optional(Schema.Array(HttpsUrl)),
  privacyPolicyUrl: HttpsUrl,
  termsOfServiceUrl: HttpsUrl,
  launchUrl: Schema.optional(LaunchUrl),
  /** Who the app is for, in the publisher's words. */
  eligibilityCriteria: Schema.optional(
    Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_ELIGIBILITY_CRITERIA_LENGTH))
  ),
  contacts: Contacts,
  publisher: Publisher,
  /** Whether the app takes on new users. */
  isEnrolling: Schema.optional(Schema.Boolean),
  registrationModes: Schema.optional(RegistrationModes),
  preassignedCredentials: Schema.optional(PreassignedCredentials),
  /** The scopes the app sends to `/authorize`, exactly as it sends them. */
  scopes: Schema.optional(Schema.Array(SmartScope)),
  intents: Schema.optional(Intents),
  /** The backend service's `$initiate-onboarding` endpoint. */
  onboardingEndpoint: Schema.optional(HttpsUrl),
  /** The backend service's offboarding endpoint. */
  offboardingEndpoint: Schema.optional(HttpsUrl),
}

/** What the type-dependent fields leave of an application object once its `type` has settled them. */
type WithoutTypeDependentFields<Fields> = Omit<
  Fields,
  'launchUrl' | 'onboardingEndpoint' | 'offboardingEndpoint'
>

/**
 * HALO's registration rule, shared by every type: `preassignedCredentials`
 * SHALL be present only when `registrationModes` includes `preassigned`, and a
 * preassigned app carries them.
 */
const credentialsMatchRegistrationModes = ({
  registrationModes,
  preassignedCredentials,
}: {
  readonly registrationModes?: readonly RegistrationMode[] | undefined
  readonly preassignedCredentials?: PreassignedCredentials | undefined
}): true | string => {
  const preassigned = registrationModes?.includes('preassigned') === true
  if (preassignedCredentials !== undefined && !preassigned) {
    return 'preassignedCredentials SHALL only be present when registrationModes includes "preassigned"'
  }
  if (preassigned && preassignedCredentials === undefined) {
    return 'registrationModes includes "preassigned" but preassignedCredentials is absent'
  }
  return true
}

const SmartAppFields = Schema.Struct({
  ...applicationFields,
  /** Launched through HALO's App Launch flow, from its `launchUrl`. */
  type: Schema.Literal('smart-app'),
})
type SmartAppFields = typeof SmartAppFields.Type

/** An app launched through HALO's App Launch flow: it carries a `launchUrl` and no onboarding endpoints. */
const SmartApp = SmartAppFields.pipe(
  Schema.filter(credentialsMatchRegistrationModes),
  Schema.filter(
    ({ onboardingEndpoint, offboardingEndpoint }) =>
      (onboardingEndpoint === undefined && offboardingEndpoint === undefined) ||
      'onboardingEndpoint and offboardingEndpoint apply only to a backend-service'
  ),
  Schema.filter(
    (app): app is WithoutTypeDependentFields<SmartAppFields> & { readonly launchUrl: LaunchUrl } =>
      app.launchUrl !== undefined,
    { message: () => 'launchUrl SHALL be present when type is "smart-app"' }
  ),
  Schema.annotations({ identifier: 'SmartApp' })
)
type SmartApp = typeof SmartApp.Type

const BackendServiceFields = Schema.Struct({
  ...applicationFields,
  /** Reached through HALO's Backend Services flow, after onboarding. */
  type: Schema.Literal('backend-service'),
})
type BackendServiceFields = typeof BackendServiceFields.Type

/** A service reached through HALO's Backend Services flow: it carries both onboarding endpoints and no `launchUrl`. */
const BackendService = BackendServiceFields.pipe(
  Schema.filter(credentialsMatchRegistrationModes),
  Schema.filter(
    ({ launchUrl }) => launchUrl === undefined || 'launchUrl applies only to a smart-app'
  ),
  Schema.filter(
    (
      service
    ): service is WithoutTypeDependentFields<BackendServiceFields> & {
      readonly onboardingEndpoint: HttpsUrl
      readonly offboardingEndpoint: HttpsUrl
    } => service.onboardingEndpoint !== undefined && service.offboardingEndpoint !== undefined,
    {
      message: () =>
        'onboardingEndpoint and offboardingEndpoint SHALL be present when type is "backend-service"',
    }
  ),
  Schema.annotations({ identifier: 'BackendService' })
)
type BackendService = typeof BackendService.Type

/** One HALO application object, told apart by its `type`. */
const App = Schema.Union(SmartApp, BackendService).annotations({ identifier: 'App' })
type App = typeof App.Type

/** The whole catalog, what `GET /apps` answers: the apps, no two sharing an `id`. */
const Catalog = Schema.Array(App).pipe(
  Schema.filter((apps) => {
    const seen = new Set<string>()
    for (const { id } of apps) {
      if (seen.has(id)) return `two apps share the id ${JSON.stringify(id)}`
      seen.add(id)
    }
    return true
  }),
  Schema.annotations({ identifier: 'Catalog' })
)
type Catalog = typeof Catalog.Type

/**
 * Where the catalog is published: `GET` it for the whole catalog. Its paths
 * under the origin are `./location.ts`'s, which a page can import without
 * this schema.
 */
const CATALOG_URL = `${sectionUrl('appCatalog')}${CATALOG_PATH}`

export {
  App,
  BackendService,
  CATALOG_URL,
  Catalog,
  Contact,
  Contacts,
  GrantType,
  HttpsUrl,
  Intent,
  Intents,
  LanguageTag,
  LaunchUrl,
  PreassignedCredentials,
  Publisher,
  RedirectUri,
  RegistrationMode,
  RegistrationModes,
  SmartApp,
  SmartScope,
  TAG_LABELS,
  Tag,
  TokenEndpointAuthMethod,
}
