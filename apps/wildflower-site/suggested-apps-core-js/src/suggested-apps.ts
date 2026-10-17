/**
 * The schema of `suggested_apps.json`, the SMART apps worth trying with a
 * Wildflower server, each tagged and explained. The marketing site publishes
 * the file at {@link SUGGESTED_APPS_URL}; it is static and hand-edited, and a
 * test in the marketing site decodes it with {@link SuggestedApps}.
 *
 * Namespace module (`import { SuggestedApps } from '@wildflowerhealthio/suggested-apps-core-js'`):
 * the document is `SuggestedApps.SuggestedApps`, one app `SuggestedApps.SuggestedApp`,
 * with `SuggestedApps.TAG_LABELS`, `SuggestedApps.SUGGESTED_APPS_URL`, …
 */

import { SITE_ORIGIN } from '@wildflowerhealthio/branding-core'
import { Scope } from '@wildflowerhealthio/scopes-core'
import { Schema } from 'effect'

/**
 * What an app is for, from a closed list: a new tag is a change to this
 * schema, and a file naming any other fails to decode. Displayed as its
 * {@link TAG_LABELS} entry.
 */
const SuggestedAppTag = Schema.Literal(
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
).annotations({ identifier: 'SuggestedAppTag' })
type SuggestedAppTag = typeof SuggestedAppTag.Type

/** The display label of each {@link SuggestedAppTag}. */
const TAG_LABELS: Readonly<Record<SuggestedAppTag, string>> = {
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
 * The URL that starts an app's SMART launch: an absolute `https:` URL with no
 * credentials, and no `iss` or `launch` query parameter, since the launcher
 * adds them for the server it launches against.
 */
const LaunchUrl = Schema.String.pipe(
  Schema.filter((text) => {
    if (!URL.canParse(text)) return `${JSON.stringify(text)} is not a URL`
    const url = new URL(text)
    if (url.protocol !== 'https:') return `${JSON.stringify(text)} is not an https: URL`
    if (url.username !== '' || url.password !== '') {
      return `${JSON.stringify(text)} carries credentials, which a published file must not`
    }
    if (url.searchParams.has('iss') || url.searchParams.has('launch')) {
      return `${JSON.stringify(text)} carries iss or launch, which the launcher adds`
    }
    return true
  }),
  Schema.annotations({ identifier: 'LaunchUrl' })
)
type LaunchUrl = typeof LaunchUrl.Type

/**
 * Who publishes an app: Wildflower Health for the apps this repository
 * builds (`first-party`), or the outside organization that does.
 */
const Publisher = Schema.Struct({
  kind: Schema.Literal('first-party', 'third-party'),
  name: Schema.NonEmptyTrimmedString,
}).annotations({ identifier: 'Publisher' })
type Publisher = typeof Publisher.Type

/** A kebab-case slug: lowercase letters and digits in runs joined by single hyphens. */
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** One suggested SMART app. */
const SuggestedApp = Schema.Struct({
  /** The app's kebab-case slug, unique within the file. */
  id: Schema.String.pipe(Schema.pattern(KEBAB_CASE)),
  /** The app's display name. */
  name: Schema.NonEmptyTrimmedString,
  /** One or two plain sentences saying what the app does. */
  description: Schema.NonEmptyTrimmedString,
  launchUrl: LaunchUrl,
  publisher: Publisher,
  /** What the app is for, at least one. */
  tags: Schema.NonEmptyArray(SuggestedAppTag),
  /** The scopes the app sends to `/authorize`, exactly as it sends them. */
  scopes: Schema.NonEmptyArray(SmartScope),
}).annotations({ identifier: 'SuggestedApp' })
type SuggestedApp = typeof SuggestedApp.Type

/** The whole `suggested_apps.json` document: its format version and the apps, no two sharing an `id`. */
const SuggestedApps = Schema.Struct({
  version: Schema.Literal(1),
  apps: Schema.Array(SuggestedApp),
}).pipe(
  Schema.filter(({ apps }) => {
    const seen = new Set<string>()
    for (const { id } of apps) {
      if (seen.has(id)) return `two apps share the id ${JSON.stringify(id)}`
      seen.add(id)
    }
    return true
  }),
  Schema.annotations({ identifier: 'SuggestedApps' })
)
type SuggestedApps = typeof SuggestedApps.Type

/** The file's path under the site's root. */
const SUGGESTED_APPS_PATH = 'suggested_apps.json'

/** Where the file is published. */
const SUGGESTED_APPS_URL = `${SITE_ORIGIN}/${SUGGESTED_APPS_PATH}`

export {
  LaunchUrl,
  Publisher,
  SmartScope,
  SUGGESTED_APPS_PATH,
  SUGGESTED_APPS_URL,
  SuggestedApp,
  SuggestedAppTag,
  SuggestedApps,
  TAG_LABELS,
}
